#!/usr/bin/env python3
"""Upload files to klips.pro's storage (Cloudflare R2), in parts that survive a flaky connection.

    scripts/upload_installer.py [--version 1.4.1] Klips-mac.dmg Klips-mac-intel.dmg Klips-windows-setup.exe
    scripts/upload_installer.py demo.mp4 demo-poster.jpg      the landing page's demo clip

The file name decides where it goes; the site only accepts the names above. With --version, a file that's
already uploaded at that version and size is skipped, so a publish that was interrupted picks up where it
stopped. Every file is tried even if one fails; the exit code is non-zero if any failed.

Reads the private upload key from ~/klips/.admin-token (never committed).
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SITE = "https://klips.pro"
PART_SIZE = 20 * 1024 * 1024  # smaller parts finish before a shaky connection drops
ATTEMPTS = 6
TOKEN_FILE = Path(__file__).resolve().parent.parent / ".admin-token"


class UploadError(RuntimeError):
    pass


def call(method: str, path: str, params: dict, body: bytes | None = None, token: str = "") -> dict:
    url = f"{SITE}{path}?{urllib.parse.urlencode(params)}"
    # Cloudflare blocks Python's default "Python-urllib" user agent (error 1010).
    headers = {"x-klips-admin": token, "user-agent": "Klips-uploader/1.1 (+https://klips.pro)"}
    if body is not None and method == "POST":
        headers["content-type"] = "application/json"
    last_error: Exception | None = None
    for attempt in range(ATTEMPTS):
        request = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500 and e.code != 429:
                raise UploadError(f"{method} {path}: HTTP {e.code} {e.read().decode(errors='replace')[:200]}") from None
            last_error = e
        except Exception as e:  # network drops, timeouts, broken pipes
            last_error = e
        wait = min(60, 5 * 2 ** attempt)
        print(f"    retrying {path} in {wait}s ({last_error})", flush=True)
        time.sleep(wait)
    raise UploadError(f"{method} {path} failed after {ATTEMPTS} attempts: {last_error}")


def upload(path: Path, token: str, version: str = "") -> None:
    key = path.name
    size = path.stat().st_size
    if version:
        remote = call("GET", "/api/admin/object", {"key": key}, token=token)
        if remote.get("exists") and remote.get("size") == size and remote.get("version") == version.lstrip("v"):
            print(f"Already uploaded {key} ({size / 1e6:.0f} MB, {version})")
            return
    start = call("POST", "/api/admin/upload/start", {"key": key, "version": version}, b"{}", token)
    upload_id = start["upload_id"]
    parts = []
    with path.open("rb") as f:
        number = 1
        while True:
            chunk = f.read(PART_SIZE)
            if not chunk:
                break
            parts.append(call("PUT", "/api/admin/upload/part", {"key": key, "upload_id": upload_id, "part": number}, chunk, token))
            print(f"  {key}: part {number} ({min(number * PART_SIZE, size) / 1e6:.0f} / {size / 1e6:.0f} MB)", flush=True)
            number += 1
    done = call("POST", "/api/admin/upload/complete", {"key": key, "upload_id": upload_id},
                json.dumps({"parts": parts}).encode(), token)
    if done.get("size") != size:
        raise UploadError(f"{key}: uploaded size {done.get('size')} doesn't match local size {size}")
    print(f"Uploaded {key} ({size / 1e6:.0f} MB)", flush=True)


def main() -> None:
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    version = ""
    if args[:1] == ["--version"] and len(args) >= 2:
        version, args = args[1], args[2:]
    token = TOKEN_FILE.read_text().strip()
    failures = []
    for arg in args:
        try:
            upload(Path(arg), token, version)
        except UploadError as e:
            print(f"FAILED {Path(arg).name}: {e}", flush=True)
            failures.append(Path(arg).name)
    if failures:
        raise SystemExit(f"Not uploaded: {', '.join(failures)}")


if __name__ == "__main__":
    main()
