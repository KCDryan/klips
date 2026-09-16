"""Final render: reframed frames + zoom punch-ins + captions/overlays piped to ffmpeg with the edited audio."""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Callable, List, Optional

import cv2
import numpy as np

from . import captions as cap_mod
from . import screenshare
from .config import PLATFORMS, ffmpeg_exe
from .media import has_audio, probe, video_encoder
from .reframe import compose, shot_at

ZOOM_PEAK, ZOOM_SPACING = 1.12, 6.0
JUMP_CUT_ZOOM = 1.06
HOOK_SECONDS, CTA_SECONDS = 3.2, 2.5


def zoom_events(words: List[dict]) -> List[tuple]:
    """Punch-ins on emphasised words, at most one every ZOOM_SPACING seconds."""
    events, last = [], -ZOOM_SPACING
    for w in words:
        if w.get("emphasis") and w["start"] - last >= ZOOM_SPACING:
            events.append((w["start"], w["end"] + 0.35))
            last = w["start"]
    return events


def zoom_at(t: float, events: List[tuple]) -> float:
    for start, end in events:
        if start - 0.15 <= t <= end + 0.2:
            if t < start:
                k = (t - (start - 0.15)) / 0.15
            elif t > end:
                k = 1 - (t - end) / 0.2
            else:
                k = 1.0
            k = max(0.0, min(1.0, k))
            return 1 + (ZOOM_PEAK - 1) * (k * k * (3 - 2 * k))  # smoothstep
    return 1.0


def apply_zoom(frame: np.ndarray, z: float) -> np.ndarray:
    if z <= 1.001:
        return frame
    h, w = frame.shape[:2]
    cw, ch = int(w / z), int(h / z)
    x0, y0 = (w - cw) // 2, int((h - ch) * 0.4)
    return cv2.resize(frame[y0:y0 + ch, x0:x0 + cw], (w, h), interpolation=cv2.INTER_LINEAR)


def audio_filter(segments: List[dict], duration: float, music: bool, music_volume: float) -> tuple:
    parts, labels = [], []
    for k, seg in enumerate(segments):
        d = seg["src_end"] - seg["src_start"]
        fade = min(0.02, d / 4)
        parts.append(f"[1:a]atrim=start={seg['src_start']:.3f}:end={seg['src_end']:.3f},asetpts=PTS-STARTPTS,"
                     f"afade=t=in:st=0:d={fade:.3f},afade=t=out:st={d - fade:.3f}:d={fade:.3f}[a{k}]")
        labels.append(f"[a{k}]")
    parts.append(f"{''.join(labels)}concat=n={len(segments)}:v=0:a=1[speech]")
    if music:
        parts += [
            f"[2:a]aloop=loop=-1:size=2000000000,atrim=0:{duration:.3f},volume={music_volume:.2f}[music]",
            "[speech]asplit[s1][s2]",
            "[music][s1]sidechaincompress=threshold=0.02:ratio=12:attack=15:release=450[ducked]",
            "[s2][ducked]amix=inputs=2:duration=first:normalize=0[mix]",
        ]
        final = "[mix]"
    else:
        final = "[speech]"
    parts.append(f"{final}loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]")
    return ";".join(parts), "[aout]"


def _speaker_frame(cap: cv2.VideoCapture, state: dict, t: float) -> Optional[np.ndarray]:
    """Frame of the separate webcam recording at time t: read forward when close, seek on jumps."""
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if state["frame"] is None or t < state["pos"] - 0.5 / fps or t > state["pos"] + 2.0:
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000)
        ok, frame = cap.read()
        if ok:
            state["frame"], state["pos"] = frame, t
        return state["frame"]
    while state["pos"] + 0.5 / fps < t:
        ok, frame = cap.read()
        if not ok:
            break
        state["frame"], state["pos"] = frame, state["pos"] + 1.0 / fps
    return state["frame"]


def render_clip(video: Path, out_path: Path, edit: dict, shots: List[dict], clip: dict, options: dict,
                brand: Optional[dict] = None, progress: Callable[[float], None] = lambda p: None) -> None:
    brand = brand or {}
    platform = PLATFORMS.get(options.get("platform", "tiktok"), PLATFORMS["tiktok"])
    out_w, out_h = platform["width"], platform["height"]
    info = probe(video)
    src_fps = info["fps"]
    fps = min(float(platform["fps"]), src_fps)
    duration = edit["duration"]
    total_frames = max(1, int(round(duration * fps)))
    s = out_w / 1080

    renderer = None
    if options.get("captions", True) and edit["words"]:
        renderer = cap_mod.CaptionRenderer(edit["words"], options.get("caption_preset", "pop"), out_w, out_h, platform, brand)
    hook_img = cap_mod.render_hook(clip["hook"], out_w, brand) if options.get("hook_text", True) and clip.get("hook") else None
    cta_img = cap_mod.render_cta(brand["cta"], out_w, brand) if brand.get("cta") else None
    logo_img = cap_mod.load_logo(brand["logo_path"], out_w) if brand.get("logo_path") else None
    zooms = zoom_events(edit["words"]) if options.get("zoom", True) else []
    accent = cap_mod.hex_to_rgb(brand.get("accent", "#FFD400"))[::-1]

    music_path = options.get("music_path")
    audio = has_audio(video)
    cmd = [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{out_w}x{out_h}", "-r", f"{fps:.4f}", "-i", "-",
           "-i", str(Path(video).resolve())]
    if audio and music_path:
        cmd += ["-i", str(Path(music_path).resolve())]
    if audio:
        graph, label = audio_filter(edit["segments"], duration, bool(music_path), float(options.get("music_volume", 0.25)))
        cmd += ["-filter_complex", graph, "-map", "0:v", "-map", label, "-c:a", "aac", "-b:a", "192k"]
    else:
        cmd += ["-map", "0:v"]
    cmd += [*video_encoder(), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", f"{duration:.3f}",
            str(Path(out_path).resolve())]

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    cap = cv2.VideoCapture(str(video))
    speaker_video = options.get("speaker_path")
    speaker_cap = (cv2.VideoCapture(str(speaker_video))
                   if speaker_video and any(sh.get("speaker_path") for sh in shots) else None)
    speaker_offset = float(options.get("speaker_offset") or 0.0)
    speaker_state = {"pos": -1.0, "frame": None}
    written, thumb = 0, None
    try:
        for k, seg in enumerate(edit["segments"]):
            first = int(round(seg["out_start"] * fps))
            last = int(round((seg["out_start"] + seg["src_end"] - seg["src_start"]) * fps))
            cap.set(cv2.CAP_PROP_POS_MSEC, seg["src_start"] * 1000)
            src_pos, frame, prev = 0, None, None
            base_zoom = JUMP_CUT_ZOOM if (options.get("zoom", True) and k % 2 == 1) else 1.0
            for f in range(first, min(last, total_frames)):
                t = f / fps
                src_t = seg["src_start"] + (t - seg["out_start"])
                target = int((src_t - seg["src_start"]) * src_fps)
                while src_pos <= target:
                    ok, nxt = cap.read()
                    if not ok:
                        break
                    frame, src_pos = nxt, src_pos + 1
                if frame is None:
                    frame = prev if prev is not None else np.zeros((info["height"], info["width"], 3), np.uint8)
                prev = frame

                shot = shot_at(shots, src_t)
                cam_frame, cam_t = None, 0.0
                if speaker_cap is not None and shot.get("speaker_path"):
                    cam_t = src_t + speaker_offset
                    cam_frame = _speaker_frame(speaker_cap, speaker_state, cam_t)
                out = compose(frame, src_t, shot, out_w, out_h, cam_frame=cam_frame, cam_t=cam_t)
                if shot["type"] not in ("letterbox", "screenshare"):
                    out = apply_zoom(out, max(base_zoom, zoom_at(t, zooms)))
                if options.get("progress_bar", True):
                    cv2.rectangle(out, (0, 0), (int(out_w * t / duration), int(10 * s)), accent, -1)
                if logo_img is not None:
                    cap_mod.blend(out, logo_img, int(40 * s), int(40 * s), 0.9)
                if hook_img is not None and t < HOOK_SECONDS:
                    fade = min(1.0, (HOOK_SECONDS - t) / 0.3)
                    cap_mod.blend(out, hook_img, (out_w - hook_img.shape[1]) // 2, int(out_h * 0.13), fade)
                if cta_img is not None and t > duration - CTA_SECONDS and duration > HOOK_SECONDS + CTA_SECONDS:
                    fade = min(1.0, (t - (duration - CTA_SECONDS)) / 0.25)
                    cap_mod.blend(out, cta_img, (out_w - cta_img.shape[1]) // 2, int(out_h * 0.13), fade)
                if renderer is not None:
                    overlay = renderer.overlay(t)
                    if overlay is not None:
                        arr, cx, cy = overlay
                        if shot["type"] == "screenshare":  # captions sit at the top of the webcam panel
                            cy = screenshare.seam_y(out_h) + int(8 * s)
                        cap_mod.blend(out, arr, cx, cy)
                if thumb is None and t >= min(1.0, duration / 2):
                    thumb = out.copy()
                proc.stdin.write(out.tobytes())
                written += 1
                if written % 30 == 0:
                    progress(written / total_frames)
        # pad if rounding left us a frame or two short of the audio
        while written < total_frames and prev is not None:
            proc.stdin.write(out.tobytes())
            written += 1
    except BrokenPipeError:
        pass
    finally:
        cap.release()
        if speaker_cap is not None:
            speaker_cap.release()
        if proc.stdin:
            proc.stdin.close()
    err = proc.stderr.read().decode(errors="ignore") if proc.stderr else ""
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg failed rendering {Path(out_path).name}: {err.strip()[-600:]}")
    if thumb is not None:
        cv2.imwrite(str(Path(out_path).with_suffix(".jpg")), cv2.resize(thumb, (out_w // 3, out_h // 3)))
    progress(1.0)
