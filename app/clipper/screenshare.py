"""Zoom / Meet / Teams screen-share handling.

When the presenter shares their screen, the recording shows the screen large and the webcam as a small tile,
usually at the top of a plain side strip (Zoom's default) or floating over a corner. We detect that, then build
a stacked vertical layout: the shared screen on top and the webcam across the bottom (CAM_FRACTION of the
height), with the face kept centred. If a separate webcam recording was uploaded, the webcam panel comes from it.
"""
from __future__ import annotations

from typing import List, Optional, Tuple

import cv2
import numpy as np

CAM_FRACTION = 0.28     # share of the output height used for the webcam
KEEP_MIN = 0.8          # never crop the shared screen narrower than this fraction of its width
IDLE_ANCHOR = 0.0       # with no on-screen movement, keep the left edge (labels and first columns live there)
ACTIVITY_BINS = 32
LINE_FRACTION = 0.6     # a floating tile's border is a strong edge along at least this share of the face band
FLAT_STD = 5.0          # a row/column this uniform is empty background
DIFF = 12.0             # mean difference from the strip background that marks tile pixels


def seam_y(out_h: int) -> int:
    return out_h - int(round(out_h * CAM_FRACTION))


# ---------- webcam tile ----------

def side_strip(gray: np.ndarray, skip_rows: Optional[Tuple[float, float]] = None,
               face_x: Optional[float] = None) -> Optional[Tuple[int, int]]:
    """Plain band of columns at the left or right edge (Zoom's speaker strip), as (x0, x1)."""
    H, W = gray.shape
    rows = np.ones(H, bool)
    if skip_rows is not None:  # ignore the rows holding the webcam tile itself
        rows[max(0, int(skip_rows[0])):max(0, int(skip_rows[1]))] = False
    if rows.sum() < 0.25 * H:
        rows[:] = True
    sample = gray[rows].astype(np.float32)
    col_std, col_mean = sample.std(axis=0), sample.mean(axis=0)

    def run(values_std, values_mean):
        flat = (values_std < FLAT_STD) & (np.abs(values_mean - values_mean[0]) < DIFF)
        return len(flat) if flat.all() else int(np.argmin(flat))

    candidates = []
    left = run(col_std, col_mean)
    if 0.08 * W <= left <= 0.45 * W:
        candidates.append((0, left))
    right = run(col_std[::-1], col_mean[::-1])
    if 0.08 * W <= right <= 0.45 * W:
        candidates.append((W - right, W))
    if face_x is not None:
        candidates = [c for c in candidates if c[0] <= face_x <= c[1]]
    return max(candidates, key=lambda c: c[1] - c[0]) if candidates else None


def _run_around(mask: np.ndarray, center: int, max_gap: int) -> Optional[Tuple[int, int]]:
    """Contiguous True run containing `center`, bridging gaps of up to `max_gap`."""
    n = len(mask)
    center = int(np.clip(center, 0, n - 1))
    if not mask[center]:
        return None
    lo = hi = center
    gap = 0
    i = center - 1
    while i >= 0:
        gap = 0 if mask[i] else gap + 1
        if gap > max_gap:
            break
        if mask[i]:
            lo = i
        i -= 1
    gap = 0
    i = center + 1
    while i < n:
        gap = 0 if mask[i] else gap + 1
        if gap > max_gap:
            break
        if mask[i]:
            hi = i
        i += 1
    return lo, hi + 1


def tile_in_strip(gray: np.ndarray, strip: Tuple[int, int], cx: float, cy: float, fw: float, fh: float) -> Optional[List[float]]:
    """The webcam tile inside a side strip: the block around the face that differs from the strip background."""
    H, _ = gray.shape
    x0, x1 = strip
    region = gray[:, x0:x1].astype(np.float32)
    outside = np.ones(H, bool)
    outside[max(0, int(cy - 2.5 * fh)):int(cy + 2.5 * fh)] = False
    background = float(np.median(region[outside])) if outside.any() else float(np.median(region))
    rows = _run_around(np.abs(region - background).mean(axis=1) > DIFF, int(cy), max_gap=max(2, int(0.1 * fh)))
    if rows is None:
        return None
    y0, y1 = rows
    cols = np.where(np.abs(region[y0:y1] - background).mean(axis=0) > DIFF)[0]
    if len(cols) < 2:
        return None
    tx0, tx1 = x0 + int(cols[0]), x0 + int(cols[-1]) + 1
    w, h = tx1 - tx0, y1 - y0
    if w < 1.5 * fw or h < 1.5 * fh:
        return None
    return [float(tx0), float(y0), float(w), float(h)]


def _walk(profile: np.ndarray, start: float, distance: float, step: int) -> Optional[int]:
    """Walk outward from the face; the first continuous line is the tile border. Running off the frame counts."""
    limit = len(profile)
    i = int(round(start))
    for _ in range(int(distance)):
        if i < 0:
            return 0
        if i >= limit:
            return limit
        if profile[i] >= LINE_FRACTION:
            return i
        i += step
    return None


def find_tile(gray: np.ndarray, cx: float, cy: float, fw: float, fh: float) -> Optional[List[float]]:
    """A floating webcam tile (x, y, w, h) around a face, found from its straight borders."""
    H, W = gray.shape
    gx = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)) > 40
    gy = np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)) > 40
    band_rows = slice(int(max(0, cy - 1.2 * fh)), int(min(H, cy + 1.2 * fh)))
    band_cols = slice(int(max(0, cx - 1.2 * fw)), int(min(W, cx + 1.2 * fw)))
    cols = gx[band_rows].mean(axis=0)
    rows = gy[:, band_cols].mean(axis=1)

    left = _walk(cols, cx - 0.9 * fw, 3.6 * fw, -1)
    right = _walk(cols, cx + 0.9 * fw, 3.6 * fw, 1)
    top = _walk(rows, cy - 0.9 * fh, 2.1 * fh, -1)
    bottom = _walk(rows, cy + 0.9 * fh, 2.1 * fh, 1)
    if sum(v is None for v in (left, right, top, bottom)) > 1:
        return None
    # One border missing (e.g. a dark background blends into the frame): infer it from a 16:9 tile.
    if left is None:
        left = right - (bottom - top) * 16 / 9
    elif right is None:
        right = left + (bottom - top) * 16 / 9
    elif top is None:
        top = bottom - (right - left) * 9 / 16
    elif bottom is None:
        bottom = top + (right - left) * 9 / 16
    x0, x1 = max(0.0, float(left)), min(float(W), float(right))
    y0, y1 = max(0.0, float(top)), min(float(H), float(bottom))
    w, h = x1 - x0, y1 - y0
    if w < 1.8 * fw or h < 1.8 * fh or w > 0.5 * W or h > 0.6 * H:
        return None
    return [x0, y0, w, h]


# ---------- shared screen ----------

def content_box(gray: np.ndarray, exclude_cols: Optional[Tuple[int, int]] = None) -> Optional[List[int]]:
    """Bounding box of the shared screen: trim plain rows/columns at the edges, and leave out a side strip."""
    H, W = gray.shape
    g = gray.astype(np.float32)
    keep = np.ones(W, bool)
    if exclude_cols is not None:
        keep[exclude_cols[0]:exclude_cols[1]] = False
    cols = np.where(keep & (g.std(axis=0) >= FLAT_STD))[0]
    if len(cols) < 2:
        return None
    x0, x1 = int(cols[0]), int(cols[-1]) + 1
    rows = np.where(g[:, x0:x1].std(axis=1) >= FLAT_STD)[0]
    if len(rows) < 2:
        return None
    y0, y1 = int(rows[0]), int(rows[-1]) + 1
    return [x0, y0, x1 - x0, y1 - y0]


def detect(gray: np.ndarray, prev_gray: Optional[np.ndarray], faces: list, scale: float,
           allow_no_tile: bool = False) -> Optional[dict]:
    """Screen-share info for one sampled frame, or None.

    `gray` is the downscaled frame, `faces` are (cx, cy, w, h) in source pixels, `scale` maps source to `gray`.
    With `allow_no_tile` (a separate webcam recording was uploaded) a screen with no visible webcam still counts.
    """
    H, W = gray.shape
    if len(faces) >= 3:  # three or more faces is a gallery view, not a screen share
        return None
    tile, strip = None, None
    if faces:
        cx, cy, fw, fh = (v * scale for v in max(faces, key=lambda f: f[3]))
        if fh > 0.16 * H:  # a big face is a normal camera shot
            return None
        strip = side_strip(gray, (cy - 2.5 * fh, cy + 2.5 * fh), face_x=cx)
        if strip is not None:
            tile = tile_in_strip(gray, strip, cx, cy, fw, fh)
        elif not (W * 0.3 < cx < W * 0.7 and cy > H * 0.3):  # floating tiles sit at the sides or along the top
            tile = find_tile(gray, cx, cy, fw, fh)
    else:
        strip = side_strip(gray)
    # Without a tile this is only a screen share when a separate webcam recording was uploaded.
    if tile is None and not allow_no_tile:
        return None

    box = content_box(gray, strip)
    if box is None:
        return None
    x0, y0, cw, ch = box
    if cw * ch < 0.25 * W * H:
        return None
    region = gray[y0:y0 + ch, x0:x0 + cw].copy()
    if tile is not None:  # a floating tile over the screen shouldn't count as screen detail or movement
        tx, ty, tw, th = (int(round(v)) for v in tile)
        region[max(0, ty - y0):max(0, ty + th - y0), max(0, tx - x0):max(0, tx + tw - x0)] = int(np.median(region))
    # Shared screens have text and UI detail; without a webcam tile to confirm it, demand more.
    if cv2.Canny(region, 60, 160).mean() / 255 < (0.015 if tile is not None else 0.03):
        return None

    activity = [0.0] * ACTIVITY_BINS
    if prev_gray is not None and prev_gray.shape == gray.shape:
        diff = np.abs(gray.astype(np.int16) - prev_gray.astype(np.int16))[y0:y0 + ch, x0:x0 + cw].astype(np.float32)
        if tile is not None:
            diff[max(0, ty - y0):max(0, ty + th - y0), max(0, tx - x0):max(0, tx + tw - x0)] = 0
        activity = [round(float(c.mean()), 3) for c in np.array_split(diff.mean(axis=0), ACTIVITY_BINS)]

    inv = 1.0 / scale
    return {"tile": [round(v * inv, 1) for v in tile] if tile is not None else None,
            "content": [round(v * inv, 1) for v in box],
            "activity": activity}


def shot_params(samples: List[dict]) -> dict:
    """Stable tile/content rectangles, screen activity and a smoothed face path for one screen-share shot."""
    screens = [s["screen"] for s in samples if s.get("screen")]
    tiles = [sc["tile"] for sc in screens if sc.get("tile")]
    tile = np.median(tiles, axis=0) if tiles and len(tiles) >= 0.5 * len(screens) else None
    content = np.median([sc["content"] for sc in screens], axis=0)
    activity = np.sum([sc.get("activity") or [0.0] * ACTIVITY_BINS for sc in screens], axis=0)

    pts = []
    if tile is not None:
        tx, ty, tw, th = tile
        pts = [(s["t"], f["cx"], f["cy"]) for s in samples for f in s["faces"]
               if tx <= f["cx"] <= tx + tw and ty <= f["cy"] <= ty + th]
    path = {"t": [], "x": [], "y": []}
    if pts:
        t, x, y = (np.array(v, dtype=np.float64) for v in zip(*pts))
        win = min(len(t), 10)

        def smooth(v):
            padded = np.pad(v, (win // 2, win - win // 2 - 1), mode="edge")
            return np.convolve(padded, np.ones(win) / win, mode="valid")

        path = {"t": t.round(3).tolist(), "x": smooth(x).round(1).tolist(), "y": smooth(y).round(1).tolist()}
    return {"tile": tile.round(1).tolist() if tile is not None else None, "content": content.round(1).tolist(),
            "activity": activity.round(3).tolist(), "face_path": path}


# ---------- layout ----------

def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def compose(frame: np.ndarray, t: float, shot: dict, out_w: int, out_h: int,
            cam_frame: Optional[np.ndarray] = None, cam_t: float = 0.0) -> np.ndarray:
    """Stack the shared screen over the webcam. `cam_frame` is the matching frame of a separate webcam recording."""
    use_speaker = cam_frame is not None and shot.get("speaker_path") is not None
    has_cam = use_speaker or shot.get("tile") is not None
    top_h = seam_y(out_h) if has_cam else out_h
    cam_h = out_h - top_h
    out = np.empty((out_h, out_w, 3), np.uint8)
    if use_speaker:
        out[top_h:] = _speaker_panel(cam_frame, cam_t, shot["speaker_path"], out_w, cam_h)
    elif has_cam:
        out[top_h:] = _tile_panel(frame, t, shot, out_w, cam_h)
    _screen_panel(frame, shot, out, out_w, top_h)
    return out


def _tile_panel(frame: np.ndarray, t: float, shot: dict, out_w: int, cam_h: int) -> np.ndarray:
    """Webcam panel cut from the small tile inside the screen-share recording."""
    H, W = frame.shape[:2]
    tx, ty, tw, th = shot["tile"]
    path = shot.get("face_path") or {"t": []}
    if path["t"]:
        fx, fy = float(np.interp(t, path["t"], path["x"])), float(np.interp(t, path["t"], path["y"]))
    else:
        fx, fy = tx + tw / 2, ty + th / 2
    aspect = out_w / cam_h
    ch, cw = th, th * aspect
    if cw > tw:
        cw, ch = tw, tw / aspect
    x0 = int(round(_clamp(fx - cw / 2, tx, tx + tw - cw)))
    y0 = int(round(_clamp(fy - ch * 0.45, ty, ty + th - ch)))
    x0, y0 = int(_clamp(x0, 0, W - 2)), int(_clamp(y0, 0, H - 2))
    cam = frame[y0:min(H, y0 + int(round(ch))), x0:min(W, x0 + int(round(cw)))]
    cam = cv2.resize(cam, (out_w, cam_h), interpolation=cv2.INTER_CUBIC)
    soft = cv2.GaussianBlur(cam, (0, 0), 1.2)
    return cv2.addWeighted(cam, 1.6, soft, -0.6, 0)  # unsharp mask: the tile is small, so sharpen the upscale


def _speaker_panel(cam_frame: np.ndarray, cam_t: float, path: dict, out_w: int, cam_h: int) -> np.ndarray:
    """Webcam panel cut from the separate full-resolution active-speaker recording, framed on the face."""
    H, W = cam_frame.shape[:2]
    if path.get("t"):
        fx, fy = float(np.interp(cam_t, path["t"], path["x"])), float(np.interp(cam_t, path["t"], path["y"]))
    else:
        fx, fy = W / 2, H / 2
    aspect = out_w / cam_h
    ch = min(float(H), max(path.get("size", H * 0.3) * 2.8, H * 0.45))
    cw = ch * aspect
    if cw > W:
        cw, ch = float(W), W / aspect
    x0 = int(round(_clamp(fx - cw / 2, 0, W - cw)))
    y0 = int(round(_clamp(fy - ch * 0.42, 0, H - ch)))
    crop = cam_frame[y0:y0 + int(round(ch)), x0:x0 + int(round(cw))]
    interp = cv2.INTER_AREA if crop.shape[1] > out_w else cv2.INTER_CUBIC
    return cv2.resize(crop, (out_w, cam_h), interpolation=interp)


def _screen_panel(frame: np.ndarray, shot: dict, out: np.ndarray, out_w: int, top_h: int) -> None:
    """Fit the shared screen into the top `top_h` rows of `out`."""
    H, W = frame.shape[:2]
    sx, sy, sw, sh = (int(round(v)) for v in shot["content"])
    sx, sy = int(_clamp(sx, 0, W - 2)), int(_clamp(sy, 0, H - 2))
    sw, sh = min(sw, W - sx), min(sh, H - sy)
    crop_w = int(round(_clamp(sh * out_w / top_h, sw * KEEP_MIN, sw)))
    activity = np.asarray(shot.get("activity") or [], dtype=np.float64)
    start = (sw - crop_w) * IDLE_ANCHOR
    if activity.size and activity.sum() > 0 and crop_w < sw:
        k = max(1, int(round(activity.size * crop_w / sw)))
        sums = np.convolve(activity, np.ones(k), mode="valid")
        best = int(np.argmax(sums))
        start = _clamp((best + k / 2) / activity.size * sw - crop_w / 2, 0, sw - crop_w)
    cx0 = sx + int(round(start))
    screen = frame[sy:sy + sh, cx0:cx0 + crop_w]

    scale = out_w / crop_w
    pw, ph = out_w, int(round(sh * scale))
    if ph > top_h:
        scale = top_h / sh
        pw, ph = int(round(crop_w * scale)), top_h
    interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    bg = cv2.resize(screen, (max(1, out_w // 12), max(1, top_h // 12)), interpolation=cv2.INTER_AREA)
    bg = cv2.GaussianBlur(bg, (0, 0), 3)
    out[:top_h] = (cv2.resize(bg, (out_w, top_h), interpolation=cv2.INTER_LINEAR) * 0.45).astype(np.uint8)
    has_cam = top_h < out.shape[0]
    px = (out_w - pw) // 2
    py = top_h - ph if has_cam else (top_h - ph) // 2  # sit right on top of the webcam, or centre when there is none
    out[py:py + ph, px:px + pw] = cv2.resize(screen, (pw, ph), interpolation=interp)
    if has_cam:
        out[max(0, top_h - 2):top_h + 2] = 0
