def test_a_reading_renders_every_part(client, finished):
    job = client.post("/speak", json={"text": "First part.\n\nSecond part."}).json()
    progress = finished(client, job["id"])
    assert progress["state"] == "ready"
    assert progress["done"] == progress["total"] == 2
