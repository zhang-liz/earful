"""A website open in the same browser must not be able to use this server."""

EVIL = {"Origin": "https://evil.example"}


def test_another_site_is_not_allowed_to_read_answers(client):
    job = client.post("/speak", json={"text": "My private notes."}).json()

    for path in ("/handoff", f"/progress-once/{job['id']}", f"/words/{job['id']}/0"):
        answer = client.get(path, headers=EVIL)
        assert "access-control-allow-origin" not in answer.headers, path


def test_another_site_cannot_get_past_the_browser_check(client):
    # A request with a JSON body makes the browser ask first. Saying nothing
    # useful to that question is what stops the request being sent.
    answer = client.options(
        "/speak",
        headers={
            **EVIL,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert "access-control-allow-origin" not in answer.headers


def test_a_form_post_cannot_start_a_reading(client):
    # A plain form needs no such check, so the server has to refuse it itself.
    answer = client.post(
        "/speak",
        content='{"text": "Spoken by another site."}',
        headers={**EVIL, "Content-Type": "text/plain"},
    )
    assert answer.status_code == 422
