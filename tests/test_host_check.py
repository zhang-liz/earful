"""A website must not be able to reach the server by pointing its name at it.

This is DNS rebinding. The browser treats the page and the server as one site,
so the only sign of it is the attacker's name in the Host header.
"""

import pytest

from app import server


@pytest.mark.parametrize(
    "host",
    ["evil.example", "evil.example:8888", "127.0.0.1.evil.example", "localhost.evil.example"],
)
def test_a_name_on_the_internet_is_refused(client, host):
    assert client.get("/voices", headers={"Host": host}).status_code == 403


@pytest.mark.parametrize(
    "host",
    [
        "localhost:8888",
        "127.0.0.1:8888",
        "[::1]:8888",
        "192.168.1.5:8888",
        "100.101.102.103",
        "mac",
        "mac:8888",
        "mac.tail1.ts.net",
        "Mac.local:8888",
        "mac.lan",
    ],
)
def test_the_ways_to_reach_this_machine_work(client, host):
    assert client.get("/voices", headers={"Host": host}).status_code == 200


def test_a_name_can_be_allowed(client, monkeypatch):
    monkeypatch.setattr(server, "ALLOWED_HOSTS", {"reader.example.com"})
    assert client.get("/voices", headers={"Host": "reader.example.com:8888"}).status_code == 200
    assert client.get("/voices", headers={"Host": "evil.example"}).status_code == 403


def test_the_check_comes_before_the_password(client, monkeypatch):
    monkeypatch.setattr(server, "PASSWORD", "hunter2")
    assert client.get("/voices", headers={"Host": "evil.example"}).status_code == 403
