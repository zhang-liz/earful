"""A paragraph with no sound must not move the audio of the ones after it."""

import io

import soundfile as sf

ARTICLE = "Hello there friend.\n\n---\n\nThe second paragraph.\n\n* * *\n\nThe third paragraph."


def spoken(client, job_id, index):
    words = client.get(f"/words/{job_id}/{index}").json()["words"]
    return [word["t"] for word in words]


def test_every_part_keeps_its_own_place(client, finished):
    job = client.post("/speak", json={"text": ARTICLE}).json()
    progress = finished(client, job["id"])

    assert progress["done"] == progress["total"] == 5
    assert spoken(client, job["id"], 0) == ["Hello", "there", "friend"]
    assert spoken(client, job["id"], 1) == []
    assert spoken(client, job["id"], 2) == ["The", "second", "paragraph"]
    assert spoken(client, job["id"], 4) == ["The", "third", "paragraph"]


def test_a_part_with_no_sound_is_still_a_file_a_browser_can_play(client, finished):
    job = client.post("/speak", json={"text": ARTICLE}).json()
    finished(client, job["id"])

    answer = client.get(f"/chunk/{job['id']}/1.wav")
    samples, _ = sf.read(io.BytesIO(answer.content))
    assert len(samples) > 0


def test_sound_without_word_timings_is_kept(client, finished, monkeypatch):
    from types import SimpleNamespace

    import numpy as np

    from app import server
    from conftest import FakeTensor

    def untimed(text, voice, speed):
        samples = np.full(server.SAMPLE_RATE, 0.1, dtype=np.float32)
        yield SimpleNamespace(audio=FakeTensor(samples), tokens=[])

    monkeypatch.setattr(server.engine, "pipeline", lambda lang: untimed)
    job = client.post("/speak", json={"text": "Some words."}).json()
    finished(client, job["id"])

    samples, rate = sf.read(io.BytesIO(client.get(f"/chunk/{job['id']}/0.wav").content))
    assert len(samples) == rate
