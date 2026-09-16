"""ffmpeg helpers, audio analysis and video probing."""
from __future__ import annotations

import subprocess
import wave
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

from .config import ffmpeg_exe, no_window

SAMPLE_RATE = 16000


def run_ffmpeg(args: list, cwd=None) -> None:
    proc = subprocess.run([ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", *args],
                          cwd=cwd, capture_output=True, text=True, **no_window())
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.strip()[-800:]}")


def probe(video: Path) -> dict:
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise RuntimeError(f"Could not read video: {video}")
    h, w = frame.shape[:2]
    return {"fps": float(fps), "width": w, "height": h, "duration": frames / fps if frames else 0.0}


def has_audio(video: Path) -> bool:
    proc = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", str(video)], capture_output=True, text=True, **no_window())
    return "Audio:" in proc.stderr


def extract_audio(video: Path, wav_path: Path) -> None:
    # first_pts=0 pads a late-starting audio track with silence so audio time matches video time.
    run_ffmpeg(["-i", str(video), "-vn", "-af", "aresample=async=1:first_pts=0", "-ac", "1",
                "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(wav_path)])


def load_audio(wav_path: Path) -> np.ndarray:
    with wave.open(str(wav_path), "rb") as wf:
        data = wf.readframes(wf.getnframes())
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


def rms_envelope(audio: np.ndarray, hop: float = 0.05) -> np.ndarray:
    """Loudness per `hop` seconds, normalised to 0..1."""
    n = int(SAMPLE_RATE * hop)
    frames = len(audio) // n
    if frames == 0:
        return np.zeros(0)
    env = np.sqrt(np.mean(audio[: frames * n].reshape(frames, n) ** 2, axis=1))
    peak = np.percentile(env, 99) or 1.0
    return np.clip(env / peak, 0, 1)


def waveform_peaks(audio: np.ndarray, start: float, end: float, points: int = 600) -> list:
    a = audio[max(0, int(start * SAMPLE_RATE)): int(end * SAMPLE_RATE)]
    if len(a) < points:
        return [0.0] * points
    chunks = np.array_split(np.abs(a), points)
    peaks = np.array([c.max() for c in chunks])
    peaks /= peaks.max() or 1.0
    return [round(float(p), 3) for p in peaks]


@lru_cache(maxsize=None)
def video_encoder() -> list:
    """Prefer Apple's hardware H.264 encoder; fall back to libx264."""
    try:
        run_ffmpeg(["-f", "lavfi", "-i", "color=black:s=64x64:d=0.2", "-c:v", "h264_videotoolbox", "-f", "null", "-"])
        return ["-c:v", "h264_videotoolbox", "-b:v", "10M", "-allow_sw", "1"]
    except RuntimeError:
        return ["-c:v", "libx264", "-preset", "medium", "-crf", "20"]
