#!/usr/bin/env python3
"""Upload files to klips.pro's storage (Cloudflare R2), in 50 MB parts.

    scripts/upload_installer.py [--version 1.4.1] Klips-mac.dmg Klips-mac-intel.dmg Klips-windows-setup.exe
    scripts/upload_installer.py demo.mp4 demo-poster.jpg      the landing page's demo clip

The file name decides where it goes; the site only accepts the names above.

Reads the private upload key from ~/klips/.admin-token (never committed).
"""
from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

SITE = "https://klips.pro"
PART_SIZE = 50 * 1024 * 1024
TOKEN_FILE = Path(__file__).resolve().parent.parent / ".admin-token"


def call(method: str, path: str, params: dict, body: bytes | None = None, token: str = "") -> dict:
    url = f"{SITE}{path}?{urllib.parse.urlencode(params)}"
    # Cloudflare blocks Python's default "Python-urllib" user agent (error 1010).
    headers = {"x-klips-admin": token, "user-agent": "Klips-uploader/1.0 (+https://klips.pro)"}
    if body is not None and method == "POST":
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                return json.loads(response.read().decode())
        except Exception as e:  # retry flaky networks, then give up loudly
            if attempt == 2:
                raise SystemExit(f"{method} {path} failed: {e}")
    return {}


def upload(path: Path, token: str, version: str = "") -> None:
    key = path.name
    size = path.stat().st_size
    start = call("POST", "/api/admin/upload/start", {"key": key, "version": version}, token=token)
    upload_id = start["upload_id"]
    parts = []
    with path.open("rb") as f:
        number = 1
        while True:
            chunk = f.read(PART_SIZE)
            if not chunk:
                break
            result = call("PUT", "/api/admin/upload/part", {"key": key, "upload_id": upload_id, "part": number}, chunk, token)
            parts.append(result)
            print(f"  {key}: part {number} ({min(number * PART_SIZE, size) / 1e6:.0f} / {size / 1e6:.0f} MB)", flush=True)
            number += 1
    done = call("POST", "/api/admin/upload/complete", {"key": key, "upload_id": upload_id},
                json.dumps({"parts": parts}).encode(), token)
    if done.get("size") != size:
        raise SystemExit(f"{key}: uploaded size {done.get('size')} doesn't match local size {size}")
    print(f"Uploaded {key} ({size / 1e6:.0f} MB)")


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    args = sys.argv[1:]
    version = ""
    if args[:1] == ["--version"] and len(args) >= 2:
        version, args = args[1], args[2:]
    token = TOKEN_FILE.read_text().strip()
    for arg in args:
        upload(Path(arg), token, version)


if __name__ == "__main__":
    main()
