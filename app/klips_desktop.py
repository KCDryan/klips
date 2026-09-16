"""Klips Engine launcher (the entry point the installers are built from).

Opening Klips starts the engine in the background, with no window, and opens klips.pro/studio in the
browser. At login it starts again quietly (`--background`). If the engine is already running, opening
Klips just opens the studio. `python app.py` still works for development.
"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser


def port_is_free(port: int) -> bool:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def get_json(url: str, headers: dict | None = None, timeout: float = 2.0):
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, dict(response.headers), json.loads(response.read().decode() or "{}")


def running_engine(ports) -> int | None:
    """The port of an engine that's already running, if there is one."""
    for port in ports:
        try:
            _, _, data = get_json(f"http://127.0.0.1:{port}/api/engine", timeout=1.0)
            if data.get("app") == "klips-engine":
                return port
        except Exception:
            continue
    return None


def wait_until_up(url: str, timeout: float = 60.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            get_json(url)
            return True
        except Exception:
            time.sleep(0.25)
    return False


def smoke_test(base: str) -> int:
    """Used by the installer builds: prove every heavy dependency and the studio connection work, then quit."""
    import cv2
    import faster_whisper  # noqa: F401
    import imageio_ffmpeg
    import mediapipe as mp
    import numpy  # noqa: F401
    from PIL import Image  # noqa: F401

    code = 0
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    if not os.path.exists(ffmpeg):
        print(f"SMOKE FAIL: ffmpeg missing at {ffmpeg}")
        return 1
    detector = mp.solutions.face_detection.FaceDetection(model_selection=1)
    detector.process(numpy.zeros((64, 64, 3), dtype=numpy.uint8))
    detector.close()
    print(f"SMOKE OK: cv2 {cv2.__version__}, mediapipe {mp.__version__}, ffmpeg {os.path.basename(ffmpeg)}")

    try:
        _, headers, info = get_json(base + "api/engine", {"Origin": "https://klips.pro"}, timeout=30)
        assert info.get("app") == "klips-engine", info
        assert headers.get("Access-Control-Allow-Origin") == "https://klips.pro", headers
        print(f"SMOKE OK: engine {info['version']} answers klips.pro")
    except Exception as e:  # noqa: BLE001 - any failure here fails the build
        print(f"SMOKE FAIL: engine info: {e}")
        code = 1
    try:
        get_json(base + "api/engine", {"Origin": "https://evil.example"})
        print("SMOKE FAIL: engine answered another website")
        code = 1
    except urllib.error.HTTPError as e:
        if e.code == 403:
            print("SMOKE OK: engine refuses other websites")
        else:
            print(f"SMOKE FAIL: unexpected status {e.code} for another website")
            code = 1
    try:
        _, _, status = get_json(base + "api/claude/status", timeout=60)
        print(f"SMOKE OK: Claude Code setup check ({status['platform']}, installed={status['installed']})")
    except Exception as e:  # noqa: BLE001
        print(f"SMOKE FAIL: Claude Code setup check: {e}")
        code = 1
    return code


def log_to_file() -> None:
    """The installed engine has no console, so keep a log people can send us."""
    from clipper.config import DATA_DIR

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log = open(DATA_DIR / "engine.log", "a", buffering=1, encoding="utf-8")  # noqa: SIM115 - lives as long as the engine
    sys.stdout = sys.stderr = log
    print(f"\n--- Klips Engine starting {time.strftime('%Y-%m-%d %H:%M:%S')} ---")


def main() -> None:
    from clipper import engine
    from clipper.config import FROZEN

    background = "--background" in sys.argv
    smoke = bool(os.environ.get("KLIPS_SMOKE_TEST"))
    if FROZEN and not smoke:
        log_to_file()

    ports = [int(os.environ["PORT"])] if os.environ.get("PORT") else list(engine.PORTS)
    if not smoke and running_engine(ports):
        print("Klips Engine is already running")
        if not background:
            webbrowser.open(engine.studio_url())
        return

    port = next((p for p in ports if port_is_free(p)), None)
    if port is None:
        print(f"No free port for Klips Engine in {ports}")
        if not background:
            webbrowser.open(engine.studio_url())
        sys.exit(1)
    base = f"http://127.0.0.1:{port}/"

    import app as klips_app
    from clipper import pipeline, store

    store.db()
    pipeline.start_worker()
    server = threading.Thread(
        target=lambda: klips_app.app.run(host="127.0.0.1", port=port, debug=False, threaded=True, use_reloader=False),
        daemon=True,
        name="klips-engine",
    )
    server.start()
    server_up = wait_until_up(base + "api/engine")

    if smoke:
        code = smoke_test(base) if server_up else 1
        if not server_up:
            print("SMOKE FAIL: engine didn't start")
        sys.exit(code)

    print(f"Klips Engine {pipeline.APP_VERSION} listening on {base}")
    if FROZEN and not os.environ.get("KLIPS_NO_AUTOSTART"):
        try:
            print(engine.install_autostart(sys.executable))
        except Exception as e:  # noqa: BLE001 - never stop the engine over this
            print(f"autostart not set: {e}")
    if not background:
        webbrowser.open(engine.studio_url())
    try:
        while server.is_alive():
            time.sleep(1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
