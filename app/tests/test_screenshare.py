import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from clipper import reframe, screenshare  # noqa: E402

TILE = (1040, 40, 220, 124)
FACE = (1150, 102, 50, 55)  # cx, cy, w, h of the presenter inside the webcam tile


def zoom_frame():
    """A 720p Zoom-style recording: a shared spreadsheet on the left, a webcam tile top-right."""
    img = np.zeros((720, 1280, 3), np.uint8)
    img[40:680, 20:1000] = 245
    for y in range(80, 660, 28):
        cv2.putText(img, "York Region 554  $1,110,582  96%  47", (40, y), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (30, 30, 30), 2)
    x, y, w, h = TILE
    img[y:y + h, x:x + w] = (90, 120, 150)
    cv2.circle(img, (FACE[0], FACE[1]), 30, (180, 200, 220), -1)
    return img


def gray(img):
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def test_detect_finds_webcam_tile_and_shared_screen():
    result = screenshare.detect(gray(zoom_frame()), None, [FACE], 1.0)
    assert result is not None
    tx, ty, tw, th = result["tile"]
    assert abs(tx - 1040) <= 3 and abs(ty - 40) <= 3
    assert abs(tw - 220) <= 6 and abs(th - 124) <= 6
    cx, cy, cw, ch = result["content"]
    assert cx <= 25 and 995 <= cx + cw < 1040  # the screen, without the webcam strip


def test_detect_on_zoom_dark_grey_background():
    img = zoom_frame()
    img[np.all(img == 0, axis=2)] = 28  # Zoom's dark grey instead of pure black
    result = screenshare.detect(gray(img), None, [FACE], 1.0)
    assert result is not None
    cx, cy, cw, ch = result["content"]
    assert cx <= 45 and 995 <= cx + cw < 1040  # blank page margins may be trimmed
    assert cy <= 70 and cy + ch >= 640


def zoom_strip_frame(with_tile=True):
    """Zoom's default layout: shared screen on the left, black speaker strip on the right, webcam tile at its top."""
    rng = np.random.default_rng(0)
    img = np.zeros((876, 1760, 3), np.uint8)
    img[:, :1440] = 235
    for y in range(40, 860, 30):  # page content spanning the full width of the shared screen
        cv2.putText(img, "Profile viewers 60  Post impressions 105", (30, y), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (40, 40, 40), 2)
        cv2.putText(img, "LinkedIn News  Top stories", (900, y), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (40, 40, 40), 2)
    img[0:36, :1440] = 70  # browser toolbar across the full width of the shared screen
    if with_tile:
        img[0:180, 1440:1760] = rng.integers(20, 200, (180, 320, 3), dtype=np.uint8)  # busy bookshelf background
        cv2.circle(img, (1600, 95), 38, (150, 170, 200), -1)
    return img


def test_detect_zoom_side_strip_layout():
    face = (1600, 95, 75, 75)
    result = screenshare.detect(gray(zoom_strip_frame()), None, [face], 1.0)
    assert result is not None
    tx, ty, tw, th = result["tile"]
    assert abs(tx - 1440) <= 4 and ty <= 4 and abs(tw - 320) <= 6 and abs(th - 180) <= 6
    cx, cy, cw, ch = result["content"]
    assert cx <= 45 and 1400 <= cx + cw <= 1444  # the screen only, not the speaker strip


def test_detect_screen_without_tile_when_webcam_file_uploaded():
    frame = gray(zoom_strip_frame(with_tile=False))
    assert screenshare.detect(frame, None, [], 1.0) is None
    result = screenshare.detect(frame, None, [], 1.0, allow_no_tile=True)
    assert result is not None and result["tile"] is None
    cx, cy, cw, ch = result["content"]
    assert cx + cw <= 1444


def test_detect_ignores_normal_facecam():
    img = np.full((720, 1280, 3), 120, np.uint8)
    assert screenshare.detect(gray(img), None, [(640, 330, 220, 260)], 1.0) is None


def test_detect_ignores_small_face_without_a_tile():
    img = np.full((720, 1280, 3), 120, np.uint8)
    cv2.circle(img, (1150, 102), 30, (200, 200, 200), -1)
    assert screenshare.detect(gray(img), None, [FACE], 1.0) is None


def test_compose_stacks_screen_over_webcam():
    img = zoom_frame()
    shot = {"type": "screenshare", "tile": list(TILE), "content": [20, 40, 980, 640],
            "activity": [0.0] * 32, "face_path": {"t": [], "x": [], "y": []}}
    out = screenshare.compose(img, 0.0, shot, 1080, 1920)
    assert out.shape == (1920, 1080, 3)
    seam = screenshare.seam_y(1920)
    assert 1920 - seam == round(1920 * screenshare.CAM_FRACTION)
    cam = out[seam + 10:]
    assert abs(float(cam[..., 0].mean()) - 90) < 40  # webcam colours fill the bottom panel
    assert out[seam - 200:seam - 10].mean() > 150    # the bright spreadsheet sits right above it


def test_activity_moves_the_screen_crop_toward_changes():
    img = zoom_frame()
    img[40:680, 20:1000] = np.linspace(0, 255, 980, dtype=np.uint8)[None, :, None]
    base = {"type": "screenshare", "tile": list(TILE), "content": [20, 40, 980, 640],
            "face_path": {"t": [], "x": [], "y": []}}
    left = screenshare.compose(img, 0, {**base, "activity": [1.0] * 4 + [0.0] * 28}, 1080, 1920)
    right = screenshare.compose(img, 0, {**base, "activity": [0.0] * 28 + [1.0] * 4}, 1080, 1920)
    row = screenshare.seam_y(1920) - 50
    assert left[row].mean() < right[row].mean()  # left crop shows the darker side of the gradient


def test_plan_shots_uses_screenshare_layout():
    img = zoom_frame()
    info = screenshare.detect(gray(img), None, [FACE], 1.0)
    samples = [{"t": i / 10, "cut": False, "audio": 0.5, "screen": info,
                "faces": [{"track": 0, "cx": FACE[0], "cy": FACE[1], "w": FACE[2], "h": FACE[3], "motion": 3}]}
               for i in range(40)]
    reframe.assign_speakers(samples)
    words = [{"text": w, "start": i * 0.4, "end": i * 0.4 + 0.3} for i, w in enumerate("here are the stats for york region.".split())]
    shots = reframe.plan_shots({"start": 0, "end": 4, "src_w": 1280, "src_h": 720, "samples": samples}, words)
    assert [s["type"] for s in shots] == ["screenshare"]
    assert shots[0]["tile"][0] == info["tile"][0]
    assert len(shots[0]["face_path"]["t"]) == 40
