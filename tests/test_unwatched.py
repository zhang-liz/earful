"""A reading nobody follows stops taking the voice engine from one being heard."""

import queue
import threading
import time

import pytest

from app import server
from conftest import fake_pipeline


@pytest.fixture
def gated(monkeypatch):
    """The voice model, held at its first part until the test lets it go."""
    first = threading.Event()

    def model(text, voice, speed):
        if text.startswith("One"):
            first.wait(5)
        yield from fake_pipeline(text, voice, speed)

    monkeypatch.setattr(server.engine, "pipeline", lambda lang: model)
    monkeypatch.setattr(server, "UNWATCHED_SECONDS", 0.3)
    return first


def done(job) -> int:
    return len(job.chunks)


def settle(seconds=0.8):
    time.sleep(seconds)


def abandoned(client, gated):
    """A reading whose reader went away while its first part was being made."""
    job_id = client.post("/speak", json={"text": "One.\n\nTwo.\n\nThree."}).json()["id"]
    job = server.JOBS[job_id]
    job.seen = time.monotonic() - 60      # nobody has asked about it for a minute
    gated.set()
    settle()
    return job_id, job


def test_a_reading_nobody_follows_waits_instead_of_rendering(client, gated):
    _, job = abandoned(client, gated)
    assert done(job) == 1, "it should stop after the part already under way"
    assert job.state == "running"


def test_it_carries_on_when_someone_asks_about_it_again(client, gated, finished):
    job_id, job = abandoned(client, gated)
    assert finished(client, job_id)["state"] == "ready"
    assert done(job) == 3


def test_an_open_progress_stream_counts_as_following(client, gated):
    job_id = client.post("/speak", json={"text": "One.\n\nTwo.\n\nThree."}).json()["id"]
    job = server.JOBS[job_id]
    with job.lock:
        job.listeners.append(queue.Queue())   # a page with the stream open
    job.seen = time.monotonic() - 60
    gated.set()
    settle()
    assert done(job) == 3


def test_a_waiting_reading_that_is_replaced_stops(client, gated):
    _, job = abandoned(client, gated)
    with job.lock:
        job.generation += 1
    settle()
    assert done(job) == 1


def test_the_handoff_from_a_playing_reader_counts_as_following(client, gated, finished):
    job_id, job = abandoned(client, gated)
    client.post("/handoff", json={"job": job_id, "index": 0, "at": 0.5})
    settle()
    assert done(job) == 3
