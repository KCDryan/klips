"""Klips Engine only answers klips.pro, on this computer."""
import plistlib

import pytest

import app as engine_app
from clipper import engine, klips_cloud


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(klips_cloud, "DATA_DIR", tmp_path)
    return engine_app.app.test_client()


def test_studio_on_klips_pro_can_use_the_engine(client):
    response = client.get("/api/engine", headers={"Origin": "https://klips.pro"})
    assert response.status_code == 200
    assert response.get_json()["app"] == "klips-engine"
    assert response.headers["Access-Control-Allow-Origin"] == "https://klips.pro"


def test_preflight_allows_private_network_access(client):
    response = client.options("/api/jobs", headers={
        "Origin": "https://klips.pro",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Private-Network": "true",
    })
    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Private-Network"] == "true"


def test_other_websites_are_refused(client):
    for method in ("get", "post", "delete"):
        response = getattr(client, method)("/api/jobs", headers={"Origin": "https://evil.example"})
        assert response.status_code == 403
        assert "Access-Control-Allow-Origin" not in response.headers


def test_dns_rebinding_hosts_are_refused(client):
    response = client.get("/api/engine", headers={"Host": "attacker.example:47813"})
    assert response.status_code == 403


def test_dev_origins_come_from_the_environment(monkeypatch):
    monkeypatch.setenv("KLIPS_ALLOWED_ORIGINS", "http://localhost:5173/")
    assert "http://localhost:5173" in engine.allowed_origins()
    monkeypatch.delenv("KLIPS_ALLOWED_ORIGINS")
    assert engine.allowed_origins() == {"https://klips.pro", "https://www.klips.pro"}


def test_link_saves_the_account(client, monkeypatch):
    monkeypatch.setattr(klips_cloud, "_post", lambda path, payload: {"email": "kirby@example.com", "tokens": 42})
    response = client.post("/api/license/link", json={"app_key": "klips-aaaa-bbbb-cccc-dddd"},
                           headers={"Origin": "https://klips.pro"})
    assert response.status_code == 200
    assert response.get_json()["email"] == "kirby@example.com"
    info = client.get("/api/engine").get_json()
    assert info["linked"] is True and info["account"] == "kirby@example.com"
    assert client.post("/api/license/link", json={"app_key": "nope"}).status_code == 400


def test_mac_autostart_only_from_applications(tmp_path, monkeypatch):
    monkeypatch.setattr(engine.sys, "platform", "darwin")
    monkeypatch.setattr(engine.Path, "home", classmethod(lambda cls: tmp_path))
    assert "skipped" in engine.install_autostart("/Volumes/Klips/Klips.app/Contents/MacOS/Klips")
    exe = "/Applications/Klips.app/Contents/MacOS/Klips"
    assert "set" in engine.install_autostart(exe)
    agent = plistlib.loads((tmp_path / "Library/LaunchAgents/pro.klips.engine.plist").read_bytes())
    assert agent["ProgramArguments"] == [exe, "--background"] and agent["RunAtLoad"] is True
    assert engine.install_autostart(exe) == "autostart already set"
