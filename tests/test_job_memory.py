"""Old readings must not fill the machine's memory."""

import threading

import pytest

from app import server
from conftest import fake_pipeline


@pytest.fixture(autouse=True)
def small_limit(monkeypatch):
    monkeypatch.setattr(server, "MAX_JOBS", 2)


def read(client, finished, words="Some words."):
    job = client.post("/speak", json={"text": words}).json()
    finished(client, job["id"])
    return job["id"]


def test_the_oldest_reading_is_forgotten_past_the_limit(client, finished):
    first, second, third = (read(client, finished) for _ in range(3))
    assert client.get(f"/progress-once/{first}").status_code == 404
    assert client.get(f"/progress-once/{second}").status_code == 200
    assert client.get(f"/progress-once/{third}").status_code == 200


def test_a_reading_being_listened_to_is_not_the_one_forgotten(client, finished):
    first = read(client, finished)
    second = read(client, finished)
    assert client.get(f"/chunk/{first}/0.wav").status_code == 200

    read(client, finished)
    assert client.get(f"/progress-once/{first}").status_code == 200
    assert client.get(f"/progress-once/{second}").status_code == 404


def test_a_reading_being_edited_is_not_the_one_forgotten(client, finished):
    first = read(client, finished)
    second = read(client, finished)
    client.post(f"/rewrite/{first}", json={"text": "New words."})
    finished(client, first)

    read(client, finished)
    assert client.get(f"/progress-once/{first}").status_code == 200
    assert client.get(f"/progress-once/{second}").status_code == 404


def test_forgetting_a_reading_still_rendering_stops_it(client, finished, monkeypatch):
    release = threading.Event()

    def slow(text, voice, speed):
        release.wait(5)
        yield from fake_pipeline(text, voice, speed)

    monkeypatch.setattr(server.engine, "pipeline", lambda lang: slow)
    job_id = client.post("/speak", json={"text": "One.\n\nTwo."}).json()["id"]
    job = server.JOBS[job_id]

    monkeypatch.setattr(server.engine, "pipeline", lambda lang: fake_pipeline)
    read(client, finished)
    read(client, finished)
    release.set()

    assert job_id not in server.JOBS
    assert job.state == "error", "anyone following it should be told it has stopped"
    deadline = threading.Event()
    deadline.wait(0.1)
    assert job.chunks == [], "it should not go on rendering"
