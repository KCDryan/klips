"""Persistent job, clip and brand-kit storage in SQLite, so work survives restarts."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from typing import Optional

from .config import DATA_DIR
from .postcopy import DEFAULT_LINK_TEXT, DEFAULT_LINK_URL

_lock = threading.RLock()
_conn: Optional[sqlite3.Connection] = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, filename TEXT, status TEXT, stage TEXT, progress REAL,
  options TEXT, error TEXT, log TEXT, created REAL, updated REAL
);
CREATE TABLE IF NOT EXISTS clips (
  job_id TEXT, idx INTEGER, data TEXT, status TEXT, progress REAL, error TEXT, updated REAL,
  PRIMARY KEY (job_id, idx)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
"""

DEFAULT_BRAND = {"font": "", "primary": "#FFFFFF", "accent": "#FFD400", "cta": "", "logo_path": "",
                 "link_url": DEFAULT_LINK_URL, "link_text": DEFAULT_LINK_TEXT}


def db() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            _conn = sqlite3.connect(str(DATA_DIR / "clipper.db"), check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.executescript(SCHEMA)
        return _conn


def _exec(sql: str, args=()):
    with _lock:
        cur = db().execute(sql, args)
        db().commit()
        return cur


def _query(sql: str, args=()) -> list:
    with _lock:
        return [dict(r) for r in db().execute(sql, args).fetchall()]


def reset_interrupted() -> None:
    """Anything that was mid-flight when the app stopped goes back in the queue."""
    _exec("UPDATE jobs SET status='queued' WHERE status='running'")
    _exec("UPDATE clips SET status='queued' WHERE status='rendering'")


# ---- jobs ----

def create_job(filename: str, options: dict, status: str = "queued") -> str:
    """Create a job. Pass status="uploading" while files are still being saved so the worker waits."""
    job_id = uuid.uuid4().hex[:10]
    now = time.time()
    _exec("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?)",
          (job_id, filename, status, status.capitalize(), 0.0, json.dumps(options), None, "[]", now, now))
    return job_id


def update_job(job_id: str, **fields) -> None:
    if "options" in fields:
        fields["options"] = json.dumps(fields["options"])
    fields["updated"] = time.time()
    cols = ", ".join(f"{k}=?" for k in fields)
    _exec(f"UPDATE jobs SET {cols} WHERE id=?", (*fields.values(), job_id))


def append_log(job_id: str, line: str) -> None:
    with _lock:
        row = db().execute("SELECT log FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row:
            log = json.loads(row["log"] or "[]")[-200:]
            log.append(line)
            _exec("UPDATE jobs SET log=?, updated=? WHERE id=?", (json.dumps(log), time.time(), job_id))


def _job_row(row: dict, with_clips: bool) -> dict:
    row["options"] = json.loads(row["options"] or "{}")
    row["log"] = json.loads(row["log"] or "[]")
    if with_clips:
        row["clips"] = list_clips(row["id"])
    return row


def get_job(job_id: str, with_clips: bool = True) -> Optional[dict]:
    rows = _query("SELECT * FROM jobs WHERE id=?", (job_id,))
    return _job_row(rows[0], with_clips) if rows else None


def list_jobs() -> list:
    return [_job_row(r, False) for r in _query("SELECT * FROM jobs ORDER BY created DESC")]


def next_queued_job() -> Optional[dict]:
    rows = _query("SELECT * FROM jobs WHERE status='queued' ORDER BY created LIMIT 1")
    return _job_row(rows[0], False) if rows else None


def delete_job(job_id: str) -> None:
    _exec("DELETE FROM clips WHERE job_id=?", (job_id,))
    _exec("DELETE FROM jobs WHERE id=?", (job_id,))


# ---- clips ----

def put_clip(job_id: str, idx: int, data: dict, status: str = "queued") -> None:
    _exec("INSERT OR REPLACE INTO clips VALUES (?,?,?,?,?,?,?)",
          (job_id, idx, json.dumps(data), status, 0.0, None, time.time()))


def update_clip(job_id: str, idx: int, data: Optional[dict] = None, **fields) -> None:
    if data is not None:
        fields["data"] = json.dumps(data)
    fields["updated"] = time.time()
    cols = ", ".join(f"{k}=?" for k in fields)
    _exec(f"UPDATE clips SET {cols} WHERE job_id=? AND idx=?", (*fields.values(), job_id, idx))


def _clip_row(row: dict) -> dict:
    data = json.loads(row.pop("data") or "{}")
    return {**data, "idx": row["idx"], "status": row["status"], "progress": row["progress"],
            "error": row["error"], "updated": row["updated"]}


def list_clips(job_id: str) -> list:
    return [_clip_row(r) for r in _query("SELECT * FROM clips WHERE job_id=? ORDER BY idx", (job_id,))]


def get_clip(job_id: str, idx: int) -> Optional[dict]:
    rows = _query("SELECT * FROM clips WHERE job_id=? AND idx=?", (job_id, idx))
    return _clip_row(rows[0]) if rows else None


def next_queued_clip() -> Optional[tuple]:
    rows = _query("SELECT c.job_id, c.idx FROM clips c JOIN jobs j ON j.id=c.job_id "
                  "WHERE c.status='queued' AND j.status='done' ORDER BY c.updated LIMIT 1")
    return (rows[0]["job_id"], rows[0]["idx"]) if rows else None


def queued_clips(limit: int) -> list:
    """Up to `limit` queued re-renders, oldest first, as (job_id, idx) pairs."""
    rows = _query("SELECT c.job_id, c.idx FROM clips c JOIN jobs j ON j.id=c.job_id "
                  "WHERE c.status='queued' AND j.status='done' ORDER BY c.updated LIMIT ?", (limit,))
    return [(r["job_id"], r["idx"]) for r in rows]


# ---- brand kit ----

def get_brand() -> dict:
    rows = _query("SELECT value FROM settings WHERE key='brand'")
    return {**DEFAULT_BRAND, **(json.loads(rows[0]["value"]) if rows else {})}


def set_brand(brand: dict) -> dict:
    merged = {**get_brand(), **{k: v for k, v in brand.items() if k in DEFAULT_BRAND}}
    _exec("INSERT OR REPLACE INTO settings VALUES ('brand', ?)", (json.dumps(merged),))
    return merged
