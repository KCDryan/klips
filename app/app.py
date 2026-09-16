#!/usr/bin/env python3
"""Klips local server: upload, progress, clip editor, brand kit, ZIP export."""
from __future__ import annotations

import json
import os
import shutil
import sys
import zipfile
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file, send_from_directory

from clipper import klips_cloud, picker, pipeline, postcopy, store
from clipper.captions import PRESETS
from clipper.config import DATA_DIR, FROZEN, PLATFORMS, available_fonts

ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
ENV_FILE = (DATA_DIR if FROZEN else ROOT) / ".env"  # the installed app's own folder is read-only
app = Flask(__name__, static_folder=str(ROOT / "static"), static_url_path="/static")

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def load_env_file() -> None:
    """Load KEY=VALUE lines from .env (saved by the in-app API key box) without overriding the real environment."""
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() and not os.environ.get(key.strip()):
            os.environ[key.strip()] = value.strip()


load_env_file()


@app.post("/api/settings/api-key")
def set_api_key():
    key = str((request.get_json(force=True) or {}).get("key", "")).strip()
    if not key.startswith("sk-ant-") or len(key) < 30:
        return jsonify(error="That doesn't look like a Claude API key. It should start with sk-ant-"), 400
    lines = [l for l in ENV_FILE.read_text().splitlines() if not l.startswith("ANTHROPIC_API_KEY=")] if ENV_FILE.exists() else []
    lines.append(f"ANTHROPIC_API_KEY={key}")
    ENV_FILE.write_text("\n".join(lines) + "\n")
    os.chmod(ENV_FILE, 0o600)  # readable only by you
    os.environ["ANTHROPIC_API_KEY"] = key
    return jsonify(ok=True)


def _klips_status() -> dict:
    """Signed-in account and token balance, as last known from klips.pro."""
    data = klips_cloud.load_license()
    tokens = int(data.get("tokens", 0))
    return {
        "activated": bool(data.get("key")),
        "email": data.get("email", ""),
        "tokens": tokens,
        "clips_available": tokens // klips_cloud.TOKENS_PER_CLIP,
        "tokens_per_clip": klips_cloud.TOKENS_PER_CLIP,
        "site": klips_cloud.API_BASE,
    }


@app.get("/api/license")
def license_status():
    return jsonify(_klips_status())


@app.post("/api/license")
def license_sign_in():
    body = request.get_json(force=True) or {}
    try:
        klips_cloud.sign_in(str(body.get("email", "")), str(body.get("password", "")))
    except klips_cloud.KlipsError as e:
        return jsonify(error=str(e)), 400
    return jsonify(_klips_status())


@app.post("/api/license/refresh")
def license_refresh():
    try:
        klips_cloud.refresh()
    except klips_cloud.KlipsError as e:
        return jsonify(error=str(e)), 400
    return jsonify(_klips_status())


@app.delete("/api/license")
def license_signout():
    klips_cloud.clear_license()
    return jsonify(_klips_status())


def _job_or_404(job_id: str) -> dict:
    job = store.get_job(job_id)
    if not job:
        abort(404)
    return job


def _bool(value, default=True) -> bool:
    if value is None:
        return default
    return str(value).lower() in ("1", "true", "on", "yes")


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/meta")
def meta():
    return jsonify(
        presets=[{"id": k, "label": v["label"]} for k, v in PRESETS.items()],
        platforms=[{"id": k, **v} for k, v in PLATFORMS.items()],
        fonts=available_fonts(),
        defaults=pipeline.DEFAULT_OPTIONS,
        api_key_set=bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")),
        llm=picker.llm_status(),
        klips=_klips_status(),
        app_version=pipeline.APP_VERSION,
    )


@app.get("/api/jobs")
def list_jobs():
    return jsonify(store.list_jobs())


@app.post("/api/jobs")
def create_job():
    video = request.files.get("video")
    if not video or Path(video.filename or "").suffix.lower() not in VIDEO_EXTS:
        return jsonify(error="Upload a video file (mp4, mov, mkv, webm)."), 400
    f = request.form
    d = pipeline.DEFAULT_OPTIONS
    options = {
        "clips": max(1, min(30, int(f.get("clips", d["clips"])))),
        "min": max(5.0, float(f.get("min", d["min"]))),
        "max": max(10.0, float(f.get("max", d["max"]))),
        "topic": f.get("topic", "").strip()[:200],
        "platform": f.get("platform") if f.get("platform") in PLATFORMS else d["platform"],
        "caption_preset": f.get("caption_preset") if f.get("caption_preset") in PRESETS else d["caption_preset"],
        "whisper": f.get("whisper") if f.get("whisper") in ("tiny", "base", "small", "medium", "large-v3") else d["whisper"],
        "language": f.get("language") or None,
        "music_volume": max(0.0, min(1.0, float(f.get("music_volume", d["music_volume"])))),
    }
    for key in ("captions", "hook_text", "remove_fillers", "cold_open", "zoom", "emoji", "progress_bar"):
        options[key] = _bool(f.get(key), default=False)
    if options["max"] < options["min"]:
        options["min"], options["max"] = options["max"], options["min"]

    job_id = store.create_job(video.filename, options, status="uploading")
    folder = pipeline.job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=True)
    video.save(folder / f"source{Path(video.filename).suffix.lower()}")
    music = request.files.get("music")
    if music and Path(music.filename or "").suffix.lower() in AUDIO_EXTS:
        music_path = folder / f"music{Path(music.filename).suffix.lower()}"
        music.save(music_path)
        options["music_path"] = str(music_path)
    webcam = request.files.get("speaker")
    if webcam and Path(webcam.filename or "").suffix.lower() in VIDEO_EXTS:
        speaker_path = folder / f"speaker{Path(webcam.filename).suffix.lower()}"
        webcam.save(speaker_path)
        options["speaker_path"] = str(speaker_path)
    store.update_job(job_id, options=options, status="queued", stage="Queued")  # all files saved: ready to process
    pipeline.start_worker()
    return jsonify(id=job_id)


@app.get("/api/jobs/<job_id>")
def get_job(job_id):
    job = _job_or_404(job_id)
    brand = store.get_brand()
    for clip in job["clips"]:
        clip["post_title"] = postcopy.post_title(clip)
        clip["description_full"] = postcopy.full_description(clip, brand)
    return jsonify(job)


@app.delete("/api/jobs/<job_id>")
def delete_job(job_id):
    job = _job_or_404(job_id)
    if job["status"] == "running":
        return jsonify(error="This project is still processing."), 409
    shutil.rmtree(pipeline.job_dir(job_id), ignore_errors=True)
    store.delete_job(job_id)
    return jsonify(ok=True)


@app.post("/api/jobs/<job_id>/retry")
def retry_job(job_id):
    job = _job_or_404(job_id)
    if job["status"] == "error":
        store.update_job(job_id, status="queued", stage="Queued", error=None)
    for clip in job["clips"]:
        if clip["status"] == "error":
            store.update_clip(job_id, clip["idx"], status="queued", error=None)
    pipeline.start_worker()
    return jsonify(ok=True)


@app.get("/api/jobs/<job_id>/transcript")
def transcript(job_id):
    job = _job_or_404(job_id)
    start, end = float(request.args.get("start", 0)), float(request.args.get("end", 1e9))
    try:
        words = pipeline.load_words(job_id, job["options"])
    except Exception:
        return jsonify([])
    return jsonify([{**w, "i": i} for i, w in enumerate(words) if start <= w["start"] <= end])


@app.get("/api/jobs/<job_id>/waveform")
def waveform(job_id):
    _job_or_404(job_id)
    start, end = float(request.args["start"]), float(request.args["end"])
    points = max(50, min(2000, int(request.args.get("points", 600))))
    return jsonify(pipeline.waveform(job_id, max(0.0, start), end, points))


@app.get("/api/jobs/<job_id>/source")
def source(job_id):
    _job_or_404(job_id)
    return send_file(pipeline.source_path(job_id), conditional=True)


@app.post("/api/jobs/<job_id>/clips/<int:idx>")
def edit_clip(job_id, idx):
    _job_or_404(job_id)
    if not store.get_clip(job_id, idx):
        abort(404)
    try:
        clip = pipeline.apply_clip_edits(job_id, idx, request.get_json(force=True) or {})
    except ValueError as e:
        return jsonify(error=str(e)), 400
    pipeline.start_worker()
    return jsonify(clip)


@app.get("/media/<job_id>/<path:name>")
def media(job_id, name):
    return send_from_directory(pipeline.clips_dir(job_id), name, conditional=True)


@app.get("/api/jobs/<job_id>/export.zip")
def export_zip(job_id):
    job = _job_or_404(job_id)
    done = [c for c in job["clips"] if c["status"] == "done" and c.get("file")]
    if not done:
        return jsonify(error="No finished clips to export yet."), 400
    zip_path = pipeline.job_dir(job_id) / "export.zip"
    brand = store.get_brand()
    sheets = []
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:
        for c in done:
            zf.write(pipeline.clips_dir(job_id) / c["file"], c["file"])
            sheet = postcopy.copy_sheet(c, brand)
            zf.writestr(Path(c["file"]).with_suffix(".txt").name, sheet)  # copy sheet next to each clip
            sheets.append(f"===== {c['file']} (score {c['virality_score']}) =====\n{sheet}")
        zf.writestr("post_copy.txt", "\n".join(sheets))
        zf.writestr("clips.json", json.dumps(done, indent=2))
    name = Path(job["filename"]).stem + "_clips.zip"
    return send_file(zip_path, as_attachment=True, download_name=name)


@app.get("/api/brand")
def get_brand():
    brand = store.get_brand()
    return jsonify({**brand, "has_logo": bool(brand.get("logo_path")) and Path(brand["logo_path"]).exists()})


@app.post("/api/brand")
def set_brand():
    f = request.form
    changes = {k: f[k].strip() for k in ("font", "primary", "accent", "cta", "link_url", "link_text") if k in f}
    if changes.get("font") and changes["font"] not in available_fonts():
        changes["font"] = ""
    if changes.get("link_url") and not changes["link_url"].startswith(("http://", "https://")):
        return jsonify(error="The description link must start with https://"), 400
    logo = request.files.get("logo")
    if logo and Path(logo.filename or "").suffix.lower() in IMAGE_EXTS:
        brand_dir = DATA_DIR / "brand"
        brand_dir.mkdir(parents=True, exist_ok=True)
        path = brand_dir / f"logo{Path(logo.filename).suffix.lower()}"
        logo.save(path)
        changes["logo_path"] = str(path)
    if _bool(f.get("remove_logo"), default=False):
        changes["logo_path"] = ""
    return jsonify(store.set_brand(changes))


@app.get("/api/brand/logo")
def brand_logo():
    path = store.get_brand().get("logo_path")
    if not path or not Path(path).exists():
        abort(404)
    return send_file(path)


if __name__ == "__main__":
    store.db()
    pipeline.start_worker()
    port = int(os.environ.get("PORT", 5055))
    print(f"AI Clipper running at http://localhost:{port}")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
