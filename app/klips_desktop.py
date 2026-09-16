"""Klips desktop launcher.

Starts the local Klips server on a free port and shows it in a native app window.
Closing the window quits Klips. This is the entry point the installers are built from;
`python app.py` still works for development.
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_until_up(url: str, timeout: float = 60.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:
            time.sleep(0.25)
    return False


def smoke_test() -> int:
    """Used by the installer builds: prove every heavy dependency made it into the package, then quit."""
    import cv2
    import faster_whisper  # noqa: F401
    import imageio_ffmpeg
    import mediapipe as mp
    import numpy  # noqa: F401
    from PIL import Image  # noqa: F401

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    if not os.path.exists(ffmpeg):
        print(f"SMOKE FAIL: ffmpeg missing at {ffmpeg}")
        return 1
    detector = mp.solutions.face_detection.FaceDetection(model_selection=1)
    detector.process(numpy.zeros((64, 64, 3), dtype=numpy.uint8))
    detector.close()
    print(f"SMOKE OK: cv2 {cv2.__version__}, mediapipe {mp.__version__}, ffmpeg {os.path.basename(ffmpeg)}")
    return 0


def main() -> None:
    port = int(os.environ.get("PORT") or free_port())
    url = f"http://127.0.0.1:{port}/"

    import app as klips_app  # imported late so the window can appear quickly on slow machines
    from clipper import pipeline, store

    store.db()
    pipeline.start_worker()
    server = threading.Thread(
        target=lambda: klips_app.app.run(host="127.0.0.1", port=port, debug=False, threaded=True, use_reloader=False),
        daemon=True,
        name="klips-server",
    )
    server.start()
    server_up = wait_until_up(url + "api/meta")

    if os.environ.get("KLIPS_SMOKE_TEST"):
        code = smoke_test()
        if not server_up:
            print("SMOKE FAIL: local server didn't start")
            code = 1
        else:
            print("SMOKE OK: local server answered")
        sys.exit(code)

    try:
        import webview  # pywebview: native window (WebKit on macOS, Edge WebView2 on Windows)
    except ImportError:
        webview = None

    if webview is None:
        webbrowser.open(url)
        try:
            while server.is_alive():
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        return

    webview.create_window("Klips", url, width=1280, height=860, min_size=(900, 640))
    webview.start()  # blocks until the window closes
    sys.exit(0)  # the server and worker threads are daemons, so they stop with the app


if __name__ == "__main__":
    main()
