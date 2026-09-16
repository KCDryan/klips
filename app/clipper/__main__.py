"""Command line: python -m clipper video.mp4 --clips 5"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from . import pipeline, store
from .captions import PRESETS
from .config import PLATFORMS


def main():
    p = argparse.ArgumentParser(prog="python -m clipper", description="Turn a long video into short-form clips.")
    p.add_argument("video", type=Path)
    p.add_argument("--out", type=Path, default=Path("output"), help="folder to copy finished clips into")
    p.add_argument("--clips", type=int, default=5)
    p.add_argument("--min", type=float, default=20, help="min clip length in seconds")
    p.add_argument("--max", type=float, default=60, help="max clip length in seconds")
    p.add_argument("--topic", default="", help='only find clips about this, e.g. "investing mistakes"')
    p.add_argument("--platform", choices=sorted(PLATFORMS), default="tiktok")
    p.add_argument("--captions", choices=sorted(PRESETS), default="pop", help="caption style")
    p.add_argument("--whisper", default="small", help="tiny | base | small | medium | large-v3")
    p.add_argument("--language", default=None)
    p.add_argument("--music", type=Path, default=None, help="background music file (ducked under speech)")
    p.add_argument("--speaker", type=Path, default=None,
                   help="separate webcam / active-speaker recording, used for sharp webcam during screen shares")
    for flag in ("no-captions", "no-fillers-removal", "no-cold-open", "no-zoom", "no-emoji", "no-progress-bar"):
        p.add_argument(f"--{flag}", action="store_true")
    a = p.parse_args()

    if not a.video.exists():
        p.error(f"file not found: {a.video}")
    if a.speaker and not a.speaker.exists():
        p.error(f"file not found: {a.speaker}")
    options = {
        "clips": a.clips, "min": a.min, "max": a.max, "topic": a.topic, "platform": a.platform,
        "caption_preset": a.captions, "whisper": a.whisper, "language": a.language,
        "music_path": str(a.music.resolve()) if a.music else None,
        "speaker_path": str(a.speaker.resolve()) if a.speaker else None,
        "captions": not a.no_captions, "remove_fillers": not a.no_fillers_removal, "cold_open": not a.no_cold_open,
        "zoom": not a.no_zoom, "emoji": not a.no_emoji, "progress_bar": not a.no_progress_bar,
    }
    job_id = store.create_job(a.video.name, options)
    folder = pipeline.job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=True)
    source = folder / f"source{a.video.suffix.lower()}"
    try:
        source.symlink_to(a.video.resolve())
    except OSError:  # Windows without symlink permission: copy instead
        shutil.copy2(a.video, source)

    pipeline.ECHO = True
    pipeline.run_job(job_id)
    job = store.get_job(job_id)
    if job["status"] != "done":
        raise SystemExit(f"Failed: {job['error']}")

    a.out.mkdir(parents=True, exist_ok=True)
    for clip in job["clips"]:
        if clip["status"] == "done":
            shutil.copy2(pipeline.clips_dir(job_id) / clip["file"], a.out / clip["file"])
            print(f"  {clip['virality_score']:>3}  {a.out / clip['file']}")
        else:
            print(f"  failed: {clip['title']}: {clip['error']}")
    print(f"\nOpen the web app (python app.py) to edit these clips. Job id: {job_id}")


if __name__ == "__main__":
    main()
