from app import server



def test_progress_says_which_voice_a_reading_uses(client, finished):
    job = client.post("/speak", json={"text": "Some words.", "voice": "bm_george"}).json()
    assert job["voice"] == "bm_george"
    assert finished(client, job["id"])["voice"] == "bm_george"


def test_progress_follows_a_voice_change(client, finished):
    job = client.post("/speak", json={"text": "Some words.", "voice": "bm_george"}).json()
    finished(client, job["id"])
    client.post(f"/voice/{job['id']}", json={"voice": "af_bella"})
    assert finished(client, job["id"])["voice"] == "af_bella"


def test_a_voice_that_cannot_load_keeps_the_reading(client, finished, monkeypatch):
    job = client.post("/speak", json={"text": "Some words.", "voice": "bm_george"}).json()
    finished(client, job["id"])

    def no_such_file(text, voice, speed):
        raise OSError("The voice file is not here and there is no internet.")
        yield

    monkeypatch.setattr(server.engine, "pipeline", lambda lang: no_such_file)
    response = client.post(f"/voice/{job['id']}", json={"voice": "af_bella"})

    assert response.status_code == 503
    assert "internet" in response.json()["detail"]
    progress = client.get(f"/progress-once/{job['id']}").json()
    assert progress["voice"] == "bm_george"
    assert progress["state"] == "ready"
    assert progress["done"] == progress["total"]
    assert client.get(f"/chunk/{job['id']}/0.wav").status_code == 200
