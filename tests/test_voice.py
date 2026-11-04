def test_progress_says_which_voice_a_reading_uses(client, finished):
    job = client.post("/speak", json={"text": "Some words.", "voice": "bm_george"}).json()
    assert job["voice"] == "bm_george"
    assert finished(client, job["id"])["voice"] == "bm_george"


def test_progress_follows_a_voice_change(client, finished):
    job = client.post("/speak", json={"text": "Some words.", "voice": "bm_george"}).json()
    finished(client, job["id"])
    client.post(f"/voice/{job['id']}", json={"voice": "af_bella"})
    assert finished(client, job["id"])["voice"] == "af_bella"
