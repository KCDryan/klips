"""Klips licence and token client.

The app runs entirely on the customer's machine; this module is the only part that talks to klips.pro.
It activates a licence key, reserves tokens before a run (3 per clip) and reports what was delivered,
so clips that fail are refunded automatically.
"""
from __future__ import annotations

import json
import os
import platform
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import List, Optional

from .config import DATA_DIR

API_BASE = os.environ.get("KLIPS_API", "https://klips.pro").rstrip("/")
TOKENS_PER_CLIP = 3
TIMEOUT = 20
USER_AGENT = f"Klips/{os.environ.get('KLIPS_VERSION', '1.0.0')} (desktop app; +https://klips.pro)"


class KlipsError(RuntimeError):
    """Something the customer needs to know about: no licence, no tokens, no connection."""


def license_file() -> Path:
    return DATA_DIR / "license.json"


def load_license() -> dict:
    try:
        return json.loads(license_file().read_text())
    except (OSError, ValueError):
        return {}


def save_license(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = license_file()
    path.write_text(json.dumps(data, indent=2))
    try:
        os.chmod(path, 0o600)  # the key is a credential
    except OSError:
        pass


def clear_license() -> None:
    license_file().unlink(missing_ok=True)


def license_key() -> str:
    return str(load_license().get("key", ""))


def device_name() -> str:
    return platform.node() or "Unknown computer"


def device_id() -> str:
    """A stable id for this machine, so the account page can show which computer made each clip."""
    data = load_license()
    if not data.get("device_id"):
        data["device_id"] = uuid.uuid4().hex
        save_license(data)
    return str(data["device_id"])


def _post(path: str, payload: dict) -> dict:
    body = json.dumps(payload).encode()
    request = urllib.request.Request(
        f"{API_BASE}{path}",
        data=body,
        headers={
            "content-type": "application/json",
            "x-klips-key": payload.get("license_key", ""),
            # Cloudflare blocks Python's default "Python-urllib" user agent (error 1010).
            "user-agent": USER_AGENT,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read().decode() or "{}")
        except ValueError:
            data = {}
        message = data.get("error") or f"Klips returned HTTP {e.code}."
        raise KlipsError(message) from None
    except urllib.error.URLError as e:
        raise KlipsError(f"Can't reach klips.pro ({e.reason}). Check your internet connection.") from None
    except TimeoutError:
        raise KlipsError("klips.pro took too long to respond. Try again in a moment.") from None


def activate(key: str) -> dict:
    """Check a licence key and remember it. Returns the account's email and token balance."""
    key = key.strip().upper()
    if not key:
        raise KlipsError("Enter your licence key.")
    data = load_license()
    result = _post("/api/app/activate", {
        "license_key": key,
        "device_id": data.get("device_id") or uuid.uuid4().hex,
        "device_name": device_name(),
    })
    save_license({
        "key": key,
        "email": result.get("email", ""),
        "device_id": data.get("device_id") or uuid.uuid4().hex,
        "tokens": result.get("tokens", 0),
    })
    return result


def refresh() -> dict:
    """Current balance for the saved licence key."""
    key = license_key()
    if not key:
        raise KlipsError("No licence key saved yet.")
    result = _post("/api/app/activate", {
        "license_key": key,
        "device_id": device_id(),
        "device_name": device_name(),
    })
    data = load_license()
    data.update(email=result.get("email", data.get("email", "")), tokens=result.get("tokens", 0))
    save_license(data)
    return result


def reserve(clips: int, source_name: str, source_seconds: float, platform_id: str, app_version: str) -> dict:
    """Take tokens before a run. Raises KlipsError with a clear message when the balance is short."""
    key = license_key()
    if not key:
        raise KlipsError("Add your licence key to start making clips.")
    return _post("/api/app/reserve", {
        "license_key": key,
        "clips": int(clips),
        "source_name": source_name,
        "source_seconds": round(float(source_seconds or 0), 1),
        "platform": platform_id,
        "app_version": app_version,
        "device_name": device_name(),
    })


def complete(generation_id: str, clips_delivered: int, titles: Optional[List[str]] = None) -> dict:
    """Report what was actually produced; undelivered clips are refunded."""
    return _post("/api/app/complete", {
        "license_key": license_key(),
        "generation_id": generation_id,
        "clips_delivered": int(clips_delivered),
        "titles": titles or [],
    })


def failed(generation_id: str, error: str) -> dict:
    """Report a failed run; all its tokens are refunded."""
    return _post("/api/app/fail", {
        "license_key": license_key(),
        "generation_id": generation_id,
        "error": str(error)[:500],
    })


def tokens_for_clips(clips: int) -> int:
    return max(0, int(clips)) * TOKENS_PER_CLIP
