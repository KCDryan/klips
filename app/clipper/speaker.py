"""Separate "active speaker" webcam recording (e.g. Zoom's "record active speaker ... separately").

Used for screen-share moments so the webcam panel comes from the full-resolution camera recording
instead of the small tile inside the screen-share recording.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional, Tuple

import cv2
import numpy as np

from . import media
from .reframe import FaceDetector

ALIGN_HOP = 0.01        # 10 ms loudness frames for syncing the two recordings
MAX_LAG = 120.0         # recordings may start up to 2 minutes apart
ALIGN_SECONDS = 600     # use the first 10 minutes of audio to sync
MIN_CONFIDENCE = 6.0    # below this the match is too weak to trust


def _envelope(audio: np.ndarray, hop: float = ALIGN_HOP) -> np.ndarray:
    n = int(media.SAMPLE_RATE * hop)
    frames = len(audio) // n
    if frames == 0:
        return np.zeros(0)
    env = np.sqrt(np.mean(audio[: frames * n].reshape(frames, n) ** 2, axis=1))
    return env - env.mean()


def estimate_offset(main_audio: np.ndarray, speaker_audio: np.ndarray) -> Tuple[float, float]:
    """(offset, confidence): add `offset` seconds to a main-recording time to reach the same moment in the speaker recording."""
    limit = int(media.SAMPLE_RATE * ALIGN_SECONDS)
    a, b = _envelope(main_audio[:limit]), _envelope(speaker_audio[:limit])
    if len(a) < 100 or len(b) < 100:
        return 0.0, 0.0
    size = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    corr = np.fft.ifft(np.fft.fft(a, size) * np.conj(np.fft.fft(b, size))).real
    max_k = min(int(MAX_LAG / ALIGN_HOP), size // 2 - 1)
    lags = np.concatenate([np.arange(0, max_k + 1), np.arange(-max_k, 0)])
    values = np.concatenate([corr[: max_k + 1], corr[size - max_k:]])
    best = int(np.argmax(values))
    confidence = float(values[best] / (np.std(values) + 1e-9))
    return round(float(-lags[best] * ALIGN_HOP), 3), round(confidence, 1)


def face_path(video: Path, start: float, end: float, sample_hz: int = 5) -> Optional[dict]:
    """Smoothed position and size of the main face in the speaker recording between start and end (speaker time)."""
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, round(fps / sample_hz))
    start = max(0.0, start)
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
    detector = FaceDetector()
    pts = []
    try:
        for i in range(max(1, int((end - start) * fps))):
            if i % step:
                if not cap.grab():
                    break
                continue
            ok, frame = cap.read()
            if not ok:
                break
            h, w = frame.shape[:2]
            scale = min(1.0, 640 / max(w, h))
            small = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else frame
            faces = detector.detect(small, scale)
            if faces:
                cx, cy, fw, fh = max(faces, key=lambda f: f[3])
                pts.append((start + i / fps, cx, cy, fh))
    finally:
        cap.release()
        detector.close()
    if not pts:
        return None
    t, x, y, size = (np.array(v, dtype=np.float64) for v in zip(*pts))
    win = min(len(t), sample_hz)

    def smooth(v):
        padded = np.pad(v, (win // 2, win - win // 2 - 1), mode="edge")
        return np.convolve(padded, np.ones(win) / win, mode="valid")

    return {"t": t.round(3).tolist(), "x": smooth(x).round(1).tolist(), "y": smooth(y).round(1).tolist(),
            "size": float(np.median(size))}
