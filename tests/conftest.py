"""Run the real server against a stand-in for the voice model.

Everything down to the model is the real code. The stand-in behaves as Kokoro
does in the ways the server relies on: a word becomes a timed token, and text
with no letters or digits in it produces no sound at all.
"""

from __future__ import annotations

import re
import time
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import server


class FakeTensor:
    def __init__(self, samples: np.ndarray) -> None:
        self.samples = samples

    def detach(self):
        return self

    def cpu(self):
        return self

    def numpy(self) -> np.ndarray:
        return self.samples


def fake_pipeline(text: str, voice: str, speed: float):
    words = re.findall(r"\w[\w'-]*", text)
    if not words:
        return
    tokens = [
        SimpleNamespace(text=word, start_ts=i * 0.1, end_ts=(i + 1) * 0.1)
        for i, word in enumerate(words)
    ]
    samples = np.full(int(server.SAMPLE_RATE * 0.1 * len(words)), 0.1, dtype=np.float32)
    yield SimpleNamespace(audio=FakeTensor(samples), tokens=tokens)


@pytest.fixture(autouse=True)
def fresh_server(monkeypatch, tmp_path):
    monkeypatch.setattr(server.engine, "pipeline", lambda lang: fake_pipeline)
    monkeypatch.setattr(server, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(server, "PASSWORD", "")
    monkeypatch.setattr(server, "HANDOFF", None)
    server.JOBS.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(server.app)


@pytest.fixture
def finished():
    """Wait for a job to stop rendering, and return its last progress."""

    def wait(client: TestClient, job_id: str) -> dict:
        deadline = time.time() + 5
        while time.time() < deadline:
            progress = client.get(f"/progress-once/{job_id}").json()
            if progress["state"] != "running":
                return progress
            time.sleep(0.01)
        raise AssertionError("the job did not finish")

    return wait
