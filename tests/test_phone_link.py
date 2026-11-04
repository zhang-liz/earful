"""The phone box must only offer an address that will open."""

import json
import subprocess
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import server

STATUS = {
    "BackendState": "Running",
    "MagicDNSSuffix": "tail1.ts.net",
    "Self": {"DNSName": "mac.tail1.ts.net."},
}


def serve_config(proxy: str) -> dict:
    return {"Web": {"mac.tail1.ts.net:80": {"Handlers": {"/": {"Proxy": proxy}}}}}


@pytest.fixture
def tailscale(monkeypatch):
    def set_up(serve: dict | None) -> None:
        def run(command, **_):
            if command[1] == "status":
                return SimpleNamespace(returncode=0, stdout=json.dumps(STATUS))
            return SimpleNamespace(returncode=0, stdout=json.dumps(serve or {}))

        monkeypatch.setattr(subprocess, "run", run)
        monkeypatch.setattr(server, "_lan_address", lambda: "192.168.1.5")

    return set_up


@pytest.fixture
def phone():
    return TestClient(server.app, base_url="http://127.0.0.1:8888")


def test_no_proxy_and_a_server_on_this_machine_only_is_not_offered(phone, tailscale, monkeypatch):
    tailscale(None)
    monkeypatch.setattr(server, "_listening_beyond_this_machine", lambda port: False)
    assert phone.get("/phone").json()["reachable"] is False


def test_no_proxy_and_a_server_open_to_the_network_gives_the_port(phone, tailscale, monkeypatch):
    tailscale(None)
    monkeypatch.setattr(server, "_listening_beyond_this_machine", lambda port: True)
    link = phone.get("/phone").json()
    assert link["reachable"] is True
    assert link["url"] == "http://mac:8888/go"


def test_a_proxy_to_this_server_gives_the_short_address(phone, tailscale, monkeypatch):
    tailscale(serve_config("http://127.0.0.1:8888"))
    monkeypatch.setattr(server, "_listening_beyond_this_machine", lambda port: False)
    link = phone.get("/phone").json()
    assert link["reachable"] is True
    assert link["url"] == "http://mac/go"


def test_a_proxy_to_some_other_program_does_not_count(phone, tailscale, monkeypatch):
    tailscale(serve_config("http://127.0.0.1:3000"))
    monkeypatch.setattr(server, "_listening_beyond_this_machine", lambda port: False)
    assert phone.get("/phone").json()["reachable"] is False


def test_the_real_port_is_used_when_the_page_came_through_the_proxy(tailscale, monkeypatch):
    # Through the proxy the address has no port, but the server's port is unchanged.
    tailscale(serve_config("http://127.0.0.1:8888"))
    asked = []
    monkeypatch.setattr(
        server, "_listening_beyond_this_machine", lambda port: asked.append(port) or False
    )

    async def as_proxied(scope, receive, send):
        scope["server"] = ("127.0.0.1", 8888)
        await server.app(scope, receive, send)

    link = TestClient(as_proxied, base_url="http://mac").get("/phone").json()
    assert asked == [8888]
    assert link["url"] == "http://mac/go"
