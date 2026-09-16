import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from clipper import media, screenshare, speaker  # noqa: E402

SR = media.SAMPLE_RATE


def speech_like(seconds, seed=0):
    """Noise bursts with pauses, loosely shaped like speech."""
    rng = np.random.default_rng(seed)
    audio = np.zeros(int(seconds * SR), np.float32)
    t = 0.0
    while t < seconds - 1:
        length = rng.uniform(0.2, 0.9)
        s, e = int(t * SR), int(min(seconds, t + length) * SR)
        audio[s:e] = rng.normal(0, rng.uniform(0.05, 0.4), e - s)
        t += length + rng.uniform(0.1, 0.7)
    return audio


def test_offset_when_speaker_recording_starts_earlier():
    main = speech_like(90)
    webcam = np.concatenate([np.zeros(int(1.5 * SR), np.float32), main])  # same moment is 1.5 s later in the webcam file
    offset, confidence = speaker.estimate_offset(main, webcam)
    assert abs(offset - 1.5) <= 0.02
    assert confidence >= speaker.MIN_CONFIDENCE


def test_offset_when_speaker_recording_starts_later():
    main = speech_like(90, seed=1)
    webcam = main[int(2.25 * SR):] * 0.6  # started 2.25 s late and quieter
    offset, _ = speaker.estimate_offset(main, webcam)
    assert abs(offset + 2.25) <= 0.02


def test_unrelated_audio_has_low_confidence():
    offset, confidence = speaker.estimate_offset(speech_like(90, seed=2), speech_like(90, seed=3))
    assert confidence < speaker.MIN_CONFIDENCE


def test_compose_uses_speaker_frame_for_webcam_panel():
    screen = np.zeros((720, 1280, 3), np.uint8)
    screen[40:680, 20:1260] = 240
    cam = np.zeros((1080, 1920, 3), np.uint8)
    cam[:] = (0, 0, 255)  # red camera frame
    shot = {"type": "screenshare", "tile": None, "content": [20, 40, 1240, 640], "activity": [0.0] * 32,
            "face_path": {"t": [], "x": [], "y": []},
            "speaker_path": {"t": [0.0], "x": [960.0], "y": [500.0], "size": 300.0}}
    out = screenshare.compose(screen, 0.0, shot, 1080, 1920, cam_frame=cam, cam_t=0.0)
    seam = screenshare.seam_y(1920)
    assert out[seam + 50:, :, 2].mean() > 200 and out[seam + 50:, :, 0].mean() < 30  # webcam panel is the red camera
    assert out[seam - 100:seam - 10].mean() > 180                                   # bright screen above it


def test_compose_without_any_webcam_source_shows_screen_full_height():
    screen = np.zeros((720, 1280, 3), np.uint8)
    screen[40:680, 20:1260] = 240
    shot = {"type": "screenshare", "tile": None, "content": [20, 40, 1240, 640], "activity": [0.0] * 32,
            "face_path": {"t": [], "x": [], "y": []}}
    out = screenshare.compose(screen, 0.0, shot, 1080, 1920)
    assert out.shape == (1920, 1080, 3)
    assert out[1900:].mean() < 120  # no webcam panel; bottom is the blurred backdrop
