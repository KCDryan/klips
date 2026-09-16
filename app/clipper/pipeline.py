"""Job orchestration with cached stage outputs, per-clip re-renders, and the background worker."""
from __future__ import annotations

import json
import os
import re
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from typing import Callable, List, Optional

import numpy as np

from . import edit as edit_mod
from . import media, picker, reframe, render, speaker, store
from .config import DATA_DIR
from .transcribe import transcribe

ECHO = False  # the CLI turns this on to print progress
ANALYSIS_PAD = 3.0  # seconds of extra analysis around each clip so small in/out edits reuse the cache
# Clips rendered at the same time. Each render uses about 2-3 cores (decode, compositing, encode).
RENDER_WORKERS = max(1, min(3, (os.cpu_count() or 2) // 3))

DEFAULT_OPTIONS = {
    "clips": 5, "min": 20, "max": 60, "topic": "", "whisper": "small", "language": None,
    "platform": "tiktok", "caption_preset": "pop", "captions": True, "hook_text": True,
    "remove_fillers": True, "cold_open": True, "zoom": True, "emoji": True, "progress_bar": True,
    "music_path": None, "music_volume": 0.25,
    "speaker_path": None, "speaker_offset": None,  # optional separate webcam recording and its sync offset
}
EDITABLE_OPTIONS = {"platform", "caption_preset", "captions", "hook_text", "remove_fillers", "cold_open",
                    "zoom", "emoji", "progress_bar", "music_volume"}


# ---------- paths and caches ----------

def job_dir(job_id: str) -> Path:
    return DATA_DIR / "jobs" / job_id


def cache_dir(job_id: str) -> Path:
    d = job_dir(job_id) / "cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def clips_dir(job_id: str) -> Path:
    d = job_dir(job_id) / "clips"
    d.mkdir(parents=True, exist_ok=True)
    return d


def source_path(job_id: str) -> Path:
    for p in job_dir(job_id).iterdir():
        if p.stem == "source":
            return p
    raise FileNotFoundError(f"Source video missing for job {job_id}")


def audio_path(job_id: str) -> Path:
    wav = cache_dir(job_id) / "audio.wav"
    if not wav.exists():
        media.extract_audio(source_path(job_id), wav)
    return wav


@lru_cache(maxsize=4)
def _audio(job_id: str) -> np.ndarray:
    return media.load_audio(audio_path(job_id))


def audio_envelope(job_id: str) -> np.ndarray:
    path = cache_dir(job_id) / "envelope.npy"
    if path.exists():
        return np.load(path)
    env = media.rms_envelope(_audio(job_id))
    np.save(path, env)
    return env


def waveform(job_id: str, start: float, end: float, points: int = 600) -> list:
    return media.waveform_peaks(_audio(job_id), start, end, points)


def load_words(job_id: str, options: dict, progress: Callable[[float], None] = lambda p: None) -> List[dict]:
    path = cache_dir(job_id) / "transcript.json"
    if path.exists():
        return json.loads(path.read_text())
    info = media.probe(source_path(job_id))
    words = transcribe(audio_path(job_id), options.get("whisper", "small"), options.get("language") or None,
                       info["duration"], progress)
    path.write_text(json.dumps(words))
    return words


def clip_analysis(job_id: str, start: float, end: float, progress: Callable[[float], None] = lambda p: None) -> dict:
    folder = cache_dir(job_id) / "analysis"
    folder.mkdir(exist_ok=True)
    for f in folder.glob("*.json"):
        a, b = (float(x) for x in f.stem.split("_"))
        if a <= start and b >= end:
            return json.loads(f.read_text())
    video = source_path(job_id)
    info = media.probe(video)
    a = max(0.0, start - ANALYSIS_PAD)
    b = min(info["duration"] or end + ANALYSIS_PAD, end + ANALYSIS_PAD)
    result = reframe.analyze(video, a, b, info["fps"], info["width"], info["height"], audio_envelope(job_id),
                             progress=progress, screen_without_tile=_speaker_video(job_id) is not None)
    (folder / f"{a:.2f}_{b:.2f}.json").write_text(json.dumps(result))
    return result


def _speaker_video(job_id: str) -> Optional[Path]:
    path = (store.get_job(job_id, with_clips=False) or {}).get("options", {}).get("speaker_path")
    return Path(path) if path and Path(path).exists() else None


def sync_speaker(job_id: str, speaker_video: Path, log: Callable[[str], None]) -> float:
    """Line up the separate webcam recording with the main recording by matching their audio."""
    if not media.has_audio(speaker_video):
        log("The webcam recording has no audio, so it can't be synced. Assuming both recordings start together.")
        return 0.0
    wav = cache_dir(job_id) / "speaker.wav"
    if not wav.exists():
        media.extract_audio(speaker_video, wav)
    offset, confidence = speaker.estimate_offset(_audio(job_id), media.load_audio(wav))
    if confidence < speaker.MIN_CONFIDENCE:
        log(f"Couldn't confidently sync the webcam recording (match score {confidence}). "
            "Assuming both recordings start together.")
        return 0.0
    log(f"Webcam recording synced ({offset:+.2f}s)")
    return offset


def _log(job_id: str, message: str) -> None:
    store.append_log(job_id, message)
    if ECHO:
        print(message, flush=True)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "clip"


# ---------- rendering ----------

def _relative(clip: dict) -> dict:
    """Convert the clip's global word indices to indices within its current i0..i1 range."""
    i0, i1 = clip["i0"], clip["i1"]
    inside = lambda i: i0 <= int(i) <= i1
    cold = clip.get("cold_open")
    return {
        "deleted": [i - i0 for i in clip.get("deleted", []) if inside(i)],
        "emphasis": [i - i0 for i in clip.get("emphasis", []) if inside(i)],
        "emojis": {str(int(i) - i0): e for i, e in (clip.get("emojis") or {}).items() if inside(i)},
        "cold_open": [cold[0] - i0, cold[1] - i0] if cold and inside(cold[0]) and inside(cold[1]) else None,
    }


def render_one(job_id: str, idx: int, progress: Callable[[float], None] = lambda p: None) -> dict:
    job = store.get_job(job_id, with_clips=False)
    clip = store.get_clip(job_id, idx)
    options = {**DEFAULT_OPTIONS, **job["options"], **(clip.get("overrides") or {})}
    words = load_words(job_id, options)
    clip_words = words[clip["i0"]: clip["i1"] + 1]
    rel = _relative(clip)
    plan = edit_mod.build_edit(
        clip_words, deleted=rel["deleted"], remove_fillers=options["remove_fillers"],
        cold_open=rel["cold_open"] if options["cold_open"] else None,
        emphasis=rel["emphasis"], emojis=rel["emojis"] if options["emoji"] else {},
    )
    if not plan["segments"] or plan["duration"] < 1:
        raise RuntimeError("Nothing left to render. Restore some words or widen the clip.")

    src_start = min(s["src_start"] for s in plan["segments"])
    src_end = max(s["src_end"] for s in plan["segments"])
    analysis = clip_analysis(job_id, src_start, src_end, lambda p: progress(0.25 * p))
    window = {**analysis, "start": src_start, "end": src_end,
              "samples": [s for s in analysis["samples"] if src_start - 0.2 <= s["t"] <= src_end + 0.2]}
    shots = reframe.plan_shots(window, clip_words)
    speaker_video = _speaker_video(job_id)
    if speaker_video is not None:  # screen shares take the webcam panel from the full-quality recording
        offset = float(options.get("speaker_offset") or 0.0)
        for s in shots:
            if s["type"] == "screenshare":
                s["speaker_path"] = speaker.face_path(speaker_video, s["start"] + offset, s["end"] + offset)

    brand = store.get_brand()
    version = int(clip.get("version", 0)) + 1
    out = clips_dir(job_id) / f"clip_{idx + 1:02d}_{_slug(clip['title'])}.mp4"
    tmp = out.with_name(out.stem + ".rendering.mp4")
    render.render_clip(source_path(job_id), tmp, plan, shots, clip, options, brand, lambda p: progress(0.25 + 0.75 * p))
    if clip.get("file") and clip["file"] != out.name:
        for old in (clips_dir(job_id) / clip["file"], (clips_dir(job_id) / clip["file"]).with_suffix(".jpg")):
            old.unlink(missing_ok=True)
    tmp.replace(out)
    if tmp.with_suffix(".jpg").exists():
        tmp.with_suffix(".jpg").replace(out.with_suffix(".jpg"))

    layouts = sorted({s["type"] for s in shots})
    data = {k: v for k, v in clip.items() if k not in ("idx", "status", "progress", "error", "updated")}
    data.update(file=out.name, thumb=out.with_suffix(".jpg").name, duration=plan["duration"],
                version=version, layouts=layouts)
    store.update_clip(job_id, idx, data=data)
    return data


def render_with_status(job_id: str, idx: int, on_progress: Callable[[float], None] = lambda p: None) -> None:
    store.update_clip(job_id, idx, status="rendering", progress=0.0, error=None)
    last = [0.0]

    def progress(p):
        on_progress(p)
        if p - last[0] >= 0.05 or p >= 1:
            last[0] = p
            store.update_clip(job_id, idx, progress=round(p, 3))

    try:
        render_one(job_id, idx, progress)
        store.update_clip(job_id, idx, status="done", progress=1.0)
    except Exception as e:
        traceback.print_exc()
        store.update_clip(job_id, idx, status="error", error=str(e))
        _log(job_id, f"Clip {idx + 1} failed: {e}")


# ---------- full job ----------

def run_job(job_id: str) -> None:
    job = store.get_job(job_id, with_clips=False)
    options = {**DEFAULT_OPTIONS, **job["options"]}

    def stage(name: str, progress: float):
        store.update_job(job_id, stage=name, progress=round(progress, 3))
        _log(job_id, name + "...")

    store.update_job(job_id, status="running", error=None)
    try:
        stage("Transcribing", 0.02)
        words = load_words(job_id, options, lambda p: store.update_job(job_id, progress=round(0.02 + 0.38 * p, 3)))
        if not words:
            raise RuntimeError("No speech found in this video.")
        _log(job_id, f"Transcribed {len(words)} words")

        speaker_video = _speaker_video(job_id)
        if speaker_video is not None and options.get("speaker_offset") is None:
            stage("Syncing the webcam recording", 0.4)
            options["speaker_offset"] = sync_speaker(job_id, speaker_video, lambda m: _log(job_id, m))
            store.update_job(job_id, options={**job["options"], "speaker_offset": options["speaker_offset"]})

        stage("Finding the best moments", 0.4)
        plan_file = cache_dir(job_id) / "plan.json"
        if plan_file.exists():
            clips = json.loads(plan_file.read_text())
        else:
            clips = plan_clips(words, options, lambda m: _log(job_id, m))
            plan_file.write_text(json.dumps(clips))
        if not clips:
            raise RuntimeError("Claude didn't find any strong clip-worthy moments. Try a wider clip length or no topic filter.")

        existing = {c["idx"]: c for c in store.list_clips(job_id)}
        for idx, c in enumerate(clips):
            if idx not in existing:
                store.put_clip(job_id, idx, {**c, "deleted": [], "overrides": {}, "version": 0})

        stage("Rendering clips", 0.55)
        total = len(clips)
        todo = [idx for idx in range(total) if store.get_clip(job_id, idx)["status"] != "done"]
        clip_progress = {idx: 0.0 for idx in todo}
        lock = threading.Lock()

        def render(idx: int) -> None:
            _log(job_id, f"Rendering clip {idx + 1}/{total}: {store.get_clip(job_id, idx)['title']}")

            def on_progress(p: float) -> None:
                with lock:
                    clip_progress[idx] = p
                    finished = (total - len(todo)) + sum(clip_progress.values())
                store.update_job(job_id, progress=round(0.55 + 0.45 * finished / total, 3))

            render_with_status(job_id, idx, on_progress)

        with ThreadPoolExecutor(max_workers=RENDER_WORKERS) as pool:  # render several clips at once
            list(pool.map(render, todo))
        store.update_job(job_id, status="done", stage="Done", progress=1.0)
        _log(job_id, f"Done: {total} clips ready")
    except Exception as e:
        traceback.print_exc()
        store.update_job(job_id, status="error", stage="Failed", error=str(e))
        _log(job_id, f"Error: {e}")


def plan_clips(words: List[dict], options: dict, log: Callable[[str], None]) -> List[dict]:
    n, min_s, max_s = int(options["clips"]), float(options["min"]), float(options["max"])
    candidates = picker.find_candidates(words, n, min_s, max_s, options.get("topic") or None, log)
    clips = []
    for c in candidates:
        span = edit_mod.snap_range(c["start"], c["end"], words, min_s, max_s)
        if not span:
            continue
        c["i0"], c["i1"] = span
        c["start"], c["end"] = words[span[0]]["start"], words[span[1]]["end"]
        clips.append(c)
    clips = edit_mod.remove_overlaps(clips)[:n]
    for c in clips:
        c["words"] = words[c["i0"]: c["i1"] + 1]
    picker.package_clips(clips, log)
    for c in clips:  # store word references as global indices so in/out edits keep them valid
        i0 = c["i0"]
        c["emphasis"] = [i0 + i for i in c.get("emphasis", [])]
        c["emojis"] = {str(i0 + int(i)): e for i, e in (c.get("emojis") or {}).items()}
        c["cold_open"] = [i0 + c["cold_open"][0], i0 + c["cold_open"][1]] if c.get("cold_open") else None
        del c["words"]
    return clips


def apply_clip_edits(job_id: str, idx: int, changes: dict) -> dict:
    """Save editor changes (in/out points, deleted words, text, per-clip options) and queue a re-render."""
    clip = store.get_clip(job_id, idx)
    job = store.get_job(job_id, with_clips=False)
    data = {k: v for k, v in clip.items() if k not in ("idx", "status", "progress", "error", "updated")}
    if "start" in changes or "end" in changes:
        words = load_words(job_id, job["options"])
        start = float(changes.get("start", clip["start"]))
        end = float(changes.get("end", clip["end"]))
        inside = [i for i, w in enumerate(words) if w["start"] >= start - 0.05 and w["end"] <= end + 0.05]
        if len(inside) < 3:
            raise ValueError("The clip needs at least a few words.")
        data.update(i0=inside[0], i1=inside[-1], start=words[inside[0]]["start"], end=words[inside[-1]]["end"])
    if "deleted" in changes:
        data["deleted"] = sorted({int(i) for i in changes["deleted"]})
    for key in ("title", "hook"):
        if key in changes:
            data[key] = str(changes[key])[:200]
    if "overrides" in changes:
        data["overrides"] = {k: v for k, v in changes["overrides"].items() if k in EDITABLE_OPTIONS}
    store.update_clip(job_id, idx, data=data, status="queued", progress=0.0, error=None)
    return store.get_clip(job_id, idx)


# ---------- worker ----------

class Worker(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True, name="clipper-worker")

    def run(self):
        store.reset_interrupted()
        while True:
            try:
                job = store.next_queued_job()
                if job:
                    run_job(job["id"])
                    continue
                queued = store.queued_clips(RENDER_WORKERS)
                if queued:
                    with ThreadPoolExecutor(max_workers=RENDER_WORKERS) as pool:  # re-render several clips at once
                        list(pool.map(lambda job_clip: render_with_status(*job_clip), queued))
                    continue
            except Exception:
                traceback.print_exc()
            time.sleep(1.0)


_worker: Optional[Worker] = None


def start_worker() -> None:
    global _worker
    if _worker is None or not _worker.is_alive():
        _worker = Worker()
        _worker.start()
