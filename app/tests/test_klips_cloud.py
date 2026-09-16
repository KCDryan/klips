"""Account sign-in for the desktop app, with klips.pro replaced by a stub."""
import json

import pytest

from clipper import klips_cloud


@pytest.fixture
def cloud(tmp_path, monkeypatch):
    monkeypatch.setattr(klips_cloud, "DATA_DIR", tmp_path)
    calls = []

    def fake_post(path, payload):
        calls.append((path, payload))
        if path == "/api/app/login":
            if payload["password"] != "right-password":
                raise klips_cloud.KlipsError("That email and password don't match.")
            return {"app_key": "KLIPS-TEST-TEST-TEST-TEST", "email": payload["email"].lower(), "tokens": 90}
        return {"email": "kirby@example.com", "tokens": 87}

    monkeypatch.setattr(klips_cloud, "_post", fake_post)
    return calls


def test_sign_in_saves_app_key_but_never_the_password(cloud, tmp_path):
    klips_cloud.sign_in(" Kirby@Example.com ", "right-password")
    saved = json.loads((tmp_path / "license.json").read_text())
    assert saved["key"] == "KLIPS-TEST-TEST-TEST-TEST"
    assert saved["email"] == "kirby@example.com"
    assert saved["tokens"] == 90
    assert "right-password" not in (tmp_path / "license.json").read_text()
    assert cloud[0][1]["email"] == "Kirby@Example.com"


def test_wrong_password_keeps_you_signed_out(cloud, tmp_path):
    with pytest.raises(klips_cloud.KlipsError):
        klips_cloud.sign_in("kirby@example.com", "wrong")
    assert klips_cloud.license_key() == ""


def test_empty_fields_are_rejected_before_calling_the_site(cloud):
    with pytest.raises(klips_cloud.KlipsError):
        klips_cloud.sign_in("", "")
    assert cloud == []


def test_later_requests_use_the_saved_app_key(cloud):
    klips_cloud.sign_in("kirby@example.com", "right-password")
    klips_cloud.refresh()
    assert cloud[-1][0] == "/api/app/activate"
    assert cloud[-1][1]["license_key"] == "KLIPS-TEST-TEST-TEST-TEST"
    klips_cloud.clear_license()
    with pytest.raises(klips_cloud.KlipsError, match="Sign in"):
        klips_cloud.refresh()
