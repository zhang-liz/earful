import base64

import pytest

from app import server


def basic(password: str) -> dict:
    token = base64.b64encode(f":{password}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


@pytest.fixture
def locked(monkeypatch):
    def lock(password: str) -> None:
        monkeypatch.setattr(server, "PASSWORD", password)

    return lock


def test_the_right_password_opens_the_server(client, locked):
    locked("hunter2")
    assert client.get("/voices", headers=basic("hunter2")).status_code == 200


def test_no_password_or_a_wrong_one_is_refused(client, locked):
    locked("hunter2")
    assert client.get("/voices").status_code == 401
    assert client.get("/voices", headers=basic("wrong")).status_code == 401


def test_a_password_with_an_accented_letter_works(client, locked):
    locked("pässword")
    assert client.get("/voices", headers=basic("pässword")).status_code == 200


def test_a_wrong_password_with_an_accented_letter_is_refused_not_a_crash(client, locked):
    locked("hunter2")
    assert client.get("/voices", headers=basic("pässword")).status_code == 401


def test_audio_plays_without_the_password_header(client, locked, finished):
    # An <audio> element cannot send one, so the job's long id is what guards it.
    job = client.post("/speak", json={"text": "Some words."}).json()
    finished(client, job["id"])
    locked("hunter2")

    assert client.get(f"/chunk/{job['id']}/0.wav").status_code == 200


def test_audio_of_an_unknown_reading_is_not_found(client, locked):
    locked("hunter2")
    assert client.get("/chunk/nothing/0.wav").status_code == 404


def test_everything_else_about_a_reading_still_needs_the_password(client, locked, finished):
    job = client.post("/speak", json={"text": "Some words."}).json()
    finished(client, job["id"])
    locked("hunter2")

    assert client.get(f"/words/{job['id']}/0").status_code == 401
    assert client.get(f"/progress-once/{job['id']}").status_code == 401
    assert client.get("/handoff").status_code == 401


def test_a_reading_id_is_too_long_to_guess(client):
    job = client.post("/speak", json={"text": "Some words."}).json()
    assert len(job["id"]) >= 32
