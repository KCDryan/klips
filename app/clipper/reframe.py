"""Speaker-aware reframing: face tracks, active-speaker detection, scene cuts and per-shot layouts.

Layouts:
  track      follow one face with a smoothed virtual camera
  split      two speakers stacked top/bottom when they trade lines quickly
  letterbox  full frame over a blurred background when there is no face (screen recordings, B-roll)
  screenshare  Zoom-style screen share: shared screen on top, webcam tile enlarged across the bottom
"""
from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Callable, List, Optional

import cv2
import numpy as np

from . import screenshare

SAMPLE_HZ = 5  # analysis frames per second
SPEECH_LEVEL = 0.12
CAMERA_EASE = 1 - 0.75 ** (10 / SAMPLE_HZ)  # same camera speed per second whatever the sample rate


class FaceDetector:
    def __init__(self):
        self._mp = None
        try:
            import mediapipe as mp

            self._mp = mp.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.55)
        except Exception:  # mediapipe missing or incompatible: fall back to OpenCV's Haar cascade
            self._haar = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

    def detect(self, small: np.ndarray, scale: float) -> list:
        """Faces as (cx, cy, w, h) in source-frame pixels."""
        h, w = small.shape[:2]
        if self._mp is not None:
            result = self._mp.process(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
            faces = []
            for d in result.detections or []:
                b = d.location_data.relative_bounding_box
                bw, bh = b.width * w, b.height * h
                if bw >= 12:
                    faces.append(((b.xmin * w + bw / 2) / scale, (b.ymin * h + bh / 2) / scale, bw / scale, bh / scale))
            return faces
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        found = self._haar.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(24, 24))
        return [((x + fw / 2) / scale, (y + fh / 2) / scale, fw / scale, fh / scale) for x, y, fw, fh in found]

    def close(self):
        if self._mp is not None:
            self._mp.close()


# Where meeting apps put small webcam tiles: right strip, left strip, top band (fractions of width/height).
EDGE_REGIONS = ((0.68, 0.0, 1.0, 1.0), (0.0, 0.0, 0.32, 1.0), (0.0, 0.0, 1.0, 0.3))


def edge_faces(detector: "FaceDetector", frame: np.ndarray) -> list:
    """Look for a small webcam face at full resolution near the frame edges, where the downscaled pass misses it."""
    H, W = frame.shape[:2]
    for fx0, fy0, fx1, fy1 in EDGE_REGIONS:
        x0, y0, x1, y1 = int(W * fx0), int(H * fy0), int(W * fx1), int(H * fy1)
        crop = frame[y0:y1, x0:x1]
        s = min(1.0, 640 / max(crop.shape[:2]))
        small = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else crop
        found = detector.detect(small, s)
        if found:
            return [(cx + x0, cy + y0, fw, fh) for cx, cy, fw, fh in found]
    return []


def _patch(gray: np.ndarray, x0: float, x1: float, y0: float, y1: float) -> Optional[np.ndarray]:
    h, w = gray.shape
    x0, x1 = int(max(0, x0)), int(min(w, x1))
    y0, y1 = int(max(0, y0)), int(min(h, y1))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    return cv2.resize(gray[y0:y1, x0:x1], (32, 20)).astype(np.float32)


def analyze(video: Path, start: float, end: float, fps: float, src_w: int, src_h: int,
            env: np.ndarray, env_hop: float = 0.05, progress: Callable[[float], None] = lambda p: None,
            screen_without_tile: bool = False) -> dict:
    """Sample the source SAMPLE_HZ times a second: faces, mouth movement, scene cuts, screen shares, audio level."""
    scale = min(1.0, 640 / max(src_w, src_h))
    step = max(1, round(fps / SAMPLE_HZ))
    n_frames = max(1, int((end - start) * fps))
    cap = cv2.VideoCapture(str(video))
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
    detector = FaceDetector()
    samples, tracks, next_id, prev_hist, prev_gray = [], {}, 0, None, None
    edge_first = False  # once a face is only found by the edge search (screen share), try that search first

    try:
        for i in range(n_frames):
            if i % step:
                if not cap.grab():
                    break
                continue
            ok, frame = cap.read()
            if not ok:
                break
            t = start + i / fps
            small = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else frame

            hist = cv2.calcHist([cv2.cvtColor(small, cv2.COLOR_BGR2HSV)], [0, 1], None, [32, 32], [0, 180, 0, 256])
            cv2.normalize(hist, hist)
            cut = prev_hist is not None and cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL) < 0.55
            prev_hist = hist
            if cut:
                tracks = {}

            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            tried_edge = edge_first and scale < 1
            detected = edge_faces(detector, frame) if tried_edge else []
            if not detected:
                detected = detector.detect(small, scale)
                if detected:
                    edge_first = False
                elif scale < 1 and not tried_edge:
                    detected = edge_faces(detector, frame)
                    edge_first = bool(detected)
            screen = screenshare.detect(gray, None if cut else prev_gray, detected, scale,
                                        allow_no_tile=screen_without_tile)
            prev_gray = gray
            faces = []
            for cx, cy, fw, fh in detected:
                taken = {f["track"] for f in faces}
                best = None
                for tid, tr in tracks.items():
                    dist = abs(tr["cx"] - cx) + abs(tr["cy"] - cy)
                    recent = len(samples) - tr["last"] <= SAMPLE_HZ * 2
                    if tid not in taken and recent and dist < 0.6 * max(fw, tr["w"]) and (best is None or dist < best[0]):
                        best = (dist, tid)
                if best is not None:
                    tid = best[1]
                else:
                    tid, next_id = next_id, next_id + 1
                    tracks[tid] = {"mouth": None, "eyes": None}
                tr = tracks[tid]

                # Mouth movement minus upper-face movement, so nodding or head turns don't count as talking.
                mouth = _patch(gray, (cx - fw * 0.3) * scale, (cx + fw * 0.3) * scale, (cy + fh * 0.1) * scale, (cy + fh * 0.5) * scale)
                eyes = _patch(gray, (cx - fw * 0.4) * scale, (cx + fw * 0.4) * scale, (cy - fh * 0.35) * scale, (cy - fh * 0.05) * scale)
                motion = 0.0
                if mouth is not None and tr["mouth"] is not None:
                    head = float(np.mean(np.abs(eyes - tr["eyes"]))) if eyes is not None and tr["eyes"] is not None else 0.0
                    motion = max(0.0, float(np.mean(np.abs(mouth - tr["mouth"]))) - 0.7 * head)
                tr.update(mouth=mouth, eyes=eyes, cx=cx, cy=cy, w=fw, h=fh, last=len(samples))
                faces.append({"track": tid, "cx": round(cx, 1), "cy": round(cy, 1), "w": round(fw, 1), "h": round(fh, 1),
                              "motion": round(motion, 2)})

            k = int(t / env_hop)
            samples.append({"t": round(t, 3), "cut": bool(cut), "audio": round(float(env[k]) if 0 <= k < len(env) else 0.0, 3),
                            "faces": faces, "screen": screen})
            if len(samples) % 25 == 0:
                progress(i / n_frames)
    finally:
        cap.release()
        detector.close()

    assign_speakers(samples)
    return {"start": start, "end": end, "src_w": src_w, "src_h": src_h, "samples": samples}


def assign_speakers(samples: List[dict]) -> None:
    """Active speaker = the visible face with the most mouth movement (1 s average) while someone is talking."""
    history: dict = {}
    active = None
    for s in samples:
        if s["cut"]:
            history.clear()
        best = None
        for f in s["faces"]:
            h = history.setdefault(f["track"], [])
            h.append(f["motion"])
            del h[:-SAMPLE_HZ]
            f["activity"] = round(sum(h) / len(h), 2)
            if best is None or f["activity"] > best["activity"]:
                best = f
        visible = {f["track"] for f in s["faces"]}
        if best is not None and (s["audio"] > SPEECH_LEVEL or active not in visible):
            active = best["track"]
        elif not visible:
            active = None
        s["active"] = active


def _sentence_bounds(words: List[dict]) -> List[float]:
    out = []
    for i, w in enumerate(words[:-1]):
        if w["text"][-1:] in ".?!" or words[i + 1]["start"] - w["end"] > 0.6:
            out.append(round((w["end"] + words[i + 1]["start"]) / 2, 3))
    return out


def _mean_x(samples: List[dict], track: int) -> float:
    xs = [f["cx"] for s in samples for f in s["faces"] if f["track"] == track]
    return sum(xs) / len(xs) if xs else 0.0


def _camera_path(samples: List[dict], track: int, src_w: int, src_h: int) -> dict:
    pts = [(s["t"], f["cx"], f["cy"], f["h"]) for s in samples for f in s["faces"] if f["track"] == track]
    if not pts:
        return {"t": [], "x": [], "y": [], "size": src_h * 0.3}
    t, x, y, size = (np.array(v, dtype=np.float64) for v in zip(*pts))

    def smooth(v):
        win = min(len(v), SAMPLE_HZ)
        padded = np.pad(v, (win // 2, win - win // 2 - 1), mode="edge")
        avg = np.convolve(padded, np.ones(win) / win, mode="valid")
        cam, dead_zone, out = avg[0], src_w * 0.03, np.empty_like(avg)
        for i, c in enumerate(avg):  # dead zone + easing: the camera only moves for real movement
            if abs(c - cam) > dead_zone:
                cam += (c - cam) * CAMERA_EASE
            out[i] = cam
        return out

    return {"t": t.round(3).tolist(), "x": smooth(x).round(1).tolist(), "y": smooth(y).round(1).tolist(),
            "size": float(np.median(size))}


def plan_shots(analysis: dict, words: List[dict]) -> List[dict]:
    """Choose a layout per shot. Shots change only at sentence boundaries or scene cuts."""
    samples = analysis["samples"]
    start, end = analysis["start"], analysis["end"]
    if not samples:
        return [{"type": "letterbox", "start": start, "end": end, "paths": []}]

    cuts = {s["t"] for s in samples if s["cut"]}
    bounds = sorted({start, end, *cuts, *(b for b in _sentence_bounds(words) if start < b < end)})
    shots = []
    for a, b in zip(bounds, bounds[1:]):
        if b - a < 0.05:
            continue
        inside = [s for s in samples if a <= s["t"] < b] or [min(samples, key=lambda s: abs(s["t"] - a))]
        if sum(1 for s in inside if s.get("screen")) >= 0.5 * len(inside):
            shot = {"type": "screenshare"}
        elif sum(1 for s in inside if s["faces"]) < 0.4 * len(inside):
            shot = {"type": "letterbox"}
        else:
            presence = Counter(f["track"] for s in inside for f in s["faces"])
            actives = [s["active"] for s in inside if s["active"] is not None]
            # Look 1 s either side so a quick "Really?" / "Yes." exchange across sentences counts as crosstalk.
            around = [s["active"] for s in samples if a - 1.0 <= s["t"] < b + 1.0 and s["active"] is not None]
            switches = sum(1 for p, q in zip(around, around[1:]) if p != q)
            regulars = [tid for tid, n in presence.most_common(2) if n >= 0.5 * len(inside)]
            if len(regulars) == 2 and switches >= 2:
                shot = {"type": "split", "tracks": sorted(regulars, key=lambda tid: _mean_x(inside, tid))}
            else:
                speaker = Counter(actives).most_common(1)[0][0] if actives else presence.most_common(1)[0][0]
                shot = {"type": "track", "tracks": [speaker]}
        shot.update(start=a, end=b, cut_before=a in cuts)
        shots.append(shot)

    merged: List[dict] = []
    for s in shots:
        m = merged[-1] if merged else None
        if m and not s["cut_before"] and m["type"] == s["type"] and m.get("tracks") == s.get("tracks"):
            m["end"] = s["end"]
        else:
            merged.append(s)
    src_w, src_h = analysis["src_w"], analysis["src_h"]
    for s in merged:
        inside = [x for x in samples if s["start"] - 0.1 <= x["t"] <= s["end"] + 0.1]
        s["paths"] = [_camera_path(inside, tid, src_w, src_h) for tid in s.get("tracks", [])]
        if s["type"] == "screenshare":
            s.update(screenshare.shot_params(inside))
    return merged


def shot_at(shots: List[dict], t: float) -> dict:
    for s in shots:
        if s["start"] <= t < s["end"]:
            return s
    return shots[-1] if t >= shots[-1]["start"] else shots[0]


def _position(path: dict, t: float, w: int, h: int) -> tuple:
    if not path["t"]:
        return w / 2, h / 2
    return float(np.interp(t, path["t"], path["x"])), float(np.interp(t, path["t"], path["y"]))


def crop_box(cx: float, cy: float, target_w: int, target_h: int, src_w: int, src_h: int,
             face_size: Optional[float] = None) -> tuple:
    """Source rectangle (x0, y0, w, h) with the target aspect ratio, centred on the subject and clamped to the frame."""
    aspect = target_w / target_h
    crop_h = float(src_h)
    if face_size:  # split panels zoom in so the face fills the panel
        crop_h = min(src_h, max(src_h * 0.45, face_size * 3.0))
    crop_w = crop_h * aspect
    if crop_w > src_w:
        crop_w, crop_h = float(src_w), src_w / aspect
    x0 = min(max(0.0, cx - crop_w / 2), src_w - crop_w)
    y0 = min(max(0.0, cy - crop_h * 0.4), src_h - crop_h)  # keep faces slightly above centre
    return int(round(x0)), int(round(y0)), int(round(crop_w)), int(round(crop_h))


def _crop_resize(frame, box, out_w, out_h):
    x0, y0, cw, ch = box
    return cv2.resize(frame[y0:y0 + ch, x0:x0 + cw], (out_w, out_h), interpolation=cv2.INTER_LINEAR)


def letterbox(frame: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
    h, w = frame.shape[:2]
    bx = crop_box(w / 2, h / 2, out_w, out_h, w, h)
    bg = cv2.resize(frame[bx[1]:bx[1] + bx[3], bx[0]:bx[0] + bx[2]], (max(1, out_w // 12), max(1, out_h // 12)),
                    interpolation=cv2.INTER_AREA)
    bg = cv2.GaussianBlur(bg, (0, 0), 3)
    out = (cv2.resize(bg, (out_w, out_h), interpolation=cv2.INTER_LINEAR) * 0.5).astype(np.uint8)
    fw, fh = out_w, int(h * out_w / w)
    if fh > out_h * 0.8:
        fh, fw = int(out_h * 0.8), int(w * out_h * 0.8 / h)
    fg = cv2.resize(frame, (fw, fh), interpolation=cv2.INTER_AREA)
    x, y = (out_w - fw) // 2, max(0, (out_h - fh) // 2 - int(out_h * 0.05))
    out[y:y + fh, x:x + fw] = fg
    return out


def compose(frame: np.ndarray, t: float, shot: dict, out_w: int, out_h: int,
            cam_frame: Optional[np.ndarray] = None, cam_t: float = 0.0) -> np.ndarray:
    h, w = frame.shape[:2]
    if shot["type"] == "screenshare":
        return screenshare.compose(frame, t, shot, out_w, out_h, cam_frame=cam_frame, cam_t=cam_t)
    if shot["type"] == "track":
        cx, cy = _position(shot["paths"][0], t, w, h)
        return _crop_resize(frame, crop_box(cx, cy, out_w, out_h, w, h), out_w, out_h)
    if shot["type"] == "split":
        half = out_h // 2
        panels = []
        for path, ph in zip(shot["paths"], (half, out_h - half)):
            cx, cy = _position(path, t, w, h)
            panels.append(_crop_resize(frame, crop_box(cx, cy, out_w, ph, w, h, path["size"]), out_w, ph))
        out = np.vstack(panels)
        out[half - 3:half + 3] = 0
        return out
    return letterbox(frame, out_w, out_h)
