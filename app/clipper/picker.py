"""Claude-powered moment selection: per-chapter candidates, a global re-rank, then per-clip packaging."""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, List, Optional

import anthropic
from pydantic import BaseModel

from . import claude_setup
from .config import MODEL, no_window
from .postcopy import normalize_hashtags

# "claude-code" (default) runs your Claude Pro/Max subscription through the Claude Code CLI.
# Set CLIPPER_LLM=api to use an Anthropic API key instead.
CLAUDE_CODE_MODEL = "opus"
CLAUDE_CODE_TIMEOUT = 20 * 60

CHAPTER_THRESHOLD = 90 * 60   # transcripts longer than this get split into chapters
CHAPTER_LEN, CHAPTER_OVERLAP = 25 * 60, 2 * 60


class Scores(BaseModel):
    hook: int
    payoff: int
    clarity: int
    emotion: int


class Candidate(BaseModel):
    start: float
    end: float
    title: str
    hook: str
    reason: str
    scores: Scores


class CandidateList(BaseModel):
    clips: List[Candidate]


class Ranking(BaseModel):
    ranked_ids: List[int]


class EmojiMark(BaseModel):
    word_index: int
    emoji: str


class Package(BaseModel):
    clip_id: int
    cold_open_start: int
    cold_open_end: int
    emphasis: List[int]
    emojis: List[EmojiMark]
    title: str
    description: str
    tiktok_caption: str
    shorts_title: str
    hashtags: List[str]


class PackageList(BaseModel):
    packages: List[Package]


EDITOR_PERSONA = """You are a senior short-form video editor who has grown channels on TikTok, Instagram Reels and YouTube Shorts. You turn long-form videos into standalone vertical clips that people watch to the end and share."""

CANDIDATE_PROMPT = EDITOR_PERSONA + """

What makes a clip work:
- The first 3 seconds hook the viewer: a bold claim, a question, a surprising number, conflict, or an emotional beat. Never start on filler ("so", "um", "anyway") or mid-sentence.
- It is self-contained: someone who never saw the full video understands it without setup.
- It has a payoff: a story resolves, a point lands, a punchline hits, or a useful takeaway is delivered. End right after the payoff, on a complete sentence.
- It is dense: no tangents, dead air, or housekeeping (intros, sponsor reads, "like and subscribe").

Rules:
- Use the transcript timestamps. start is the start time of the line where the clip begins; end is the end time of the line where it ends.
- Clips must not overlap.
- Score each clip 1-100 on hook (first 3 seconds), payoff, clarity (standalone understanding) and emotion (how much it makes people feel something). Be honest and spread scores out; most moments are not 90+.
- title: a punchy post title under 70 characters, no hashtags.
- hook: 2-6 words of on-screen text for the first seconds (e.g. "He lost $2M in one day").
- reason: one sentence on why this moment will perform.
- If there are no strong moments, return fewer clips rather than weak ones."""

RANK_PROMPT = EDITOR_PERSONA + """

You are given candidate clips found in different chapters of the same long video. Choose the final set to publish.
- Rank the strongest clips first, judging hook, payoff, standalone clarity and emotion.
- Remove near-duplicates: if two candidates tell the same story or make the same point, keep only the better one.
- Return only candidate ids from the list, best first."""

PACKAGE_PROMPT = EDITOR_PERSONA + """

For each clip you get its words with indices. Prepare it for publishing:
- cold_open_start / cold_open_end: if the single strongest line (a shocking claim, punchline or question) starts 2-10 seconds into the clip, give the word index range of that line so it can play first as a cold open. It must be a complete phrase, 3-15 words long. Use -1 for both if the clip already opens strong.
- emphasis: word indices of 1-2 power words per sentence (numbers, strong verbs, surprising nouns). Never filler or articles.
- emojis: at most one emoji every ~8 seconds, only where it genuinely adds meaning (e.g. money, fire, shock). Use word_index for the word it appears with. It is fine to return none.
- title: the optimized post title, under 70 characters. Lead with the hook or payoff, use the words people would actually search for, and create curiosity the clip genuinely pays off. No hashtags or emoji.
- description: an optimized description, 2-4 sentences and under 600 characters. The first sentence restates the hook using the main keyword; then say what the viewer will learn or feel; end with a question or prompt that invites comments. Plain text only: no hashtags and no links (a link is added automatically after it).
- tiktok_caption: 1-2 sentence caption that makes people want to watch, under 150 characters, no hashtags.
- shorts_title: YouTube Shorts title under 60 characters.
- hashtags: 5-8 hashtags: 2-3 broad, high-volume tags for the niche plus specific tags for this clip's topic. Each starts with # and has no spaces."""


def backend() -> str:
    return "api" if os.environ.get("CLIPPER_LLM", "").strip().lower() == "api" else "claude-code"


def claude_bin() -> Optional[str]:
    return claude_setup.find_claude()


def _subscription_env() -> dict:
    # An API key in the environment would be billed instead of the subscription, so hide it from Claude Code.
    return {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}


def claude_logged_in(exe: str) -> bool:
    try:
        proc = subprocess.run([exe, "auth", "status", "--text"], capture_output=True, text=True, timeout=20,
                              env=_subscription_env(), stdin=subprocess.DEVNULL, **no_window())
    except (OSError, subprocess.TimeoutExpired):
        return False
    output = (proc.stdout + proc.stderr).lower()
    if "not logged in" in output or "not signed in" in output:
        return False
    return "login method" in output or proc.returncode == 0


def llm_status() -> dict:
    if backend() == "api":
        ready = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
        return {"backend": "api", "ready": ready}
    exe = claude_bin()
    installed = exe is not None
    logged_in = installed and claude_logged_in(exe)
    status = {
        "backend": "claude-code",
        "ready": logged_in,
        "installed": installed,
        "logged_in": logged_in,
        "platform": claude_setup.platform_id(),
        "install_command": claude_setup.install_command(),
        "install": claude_setup.install_state(),
    }
    if not installed:
        status["message"] = "Claude Code isn't installed on this computer yet."
    elif not logged_in:
        status["message"] = "Sign in to Claude Code with your Claude Pro or Max account."
    return status


def _parse(system: str, user: str, schema):
    return _parse_api(system, user, schema) if backend() == "api" else _parse_claude_code(system, user, schema)


def _extract_json(text: str):
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise RuntimeError("Claude Code didn't return JSON.")
    return json.loads(text[start:end + 1])


def _parse_claude_code(system: str, user: str, schema):
    exe = claude_bin()
    if not exe:
        raise RuntimeError("Claude Code isn't set up on this computer. Use the Connect Claude Code steps at the top of Klips.")
    env = _subscription_env()
    cmd = [exe, "-p", "--output-format", "json", "--model", CLAUDE_CODE_MODEL,
           "--json-schema", json.dumps(schema.model_json_schema()),
           "--system-prompt", system, "--tools", "", "--no-session-persistence",
           "--strict-mcp-config", "--disable-slash-commands"]
    with tempfile.TemporaryDirectory() as empty_dir:  # no project files or CLAUDE.md to pick up
        try:
            proc = subprocess.run(cmd, input=user, capture_output=True, text=True, env=env, cwd=empty_dir,
                                  timeout=CLAUDE_CODE_TIMEOUT, encoding="utf-8", errors="replace", **no_window())
        except subprocess.TimeoutExpired:
            raise RuntimeError("Claude Code took too long to respond. Try again.")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"Claude Code failed: {(proc.stderr or proc.stdout).strip()[-500:]}")
    if isinstance(data, list):
        data = next((d for d in reversed(data) if isinstance(d, dict) and d.get("type") == "result"), {})
    if proc.returncode != 0 or data.get("is_error"):
        message = str(data.get("result") or proc.stderr or "unknown error").strip()
        if any(w in message.lower() for w in ("login", "log in", "auth", "credential")):
            message += " Sign in again with the Connect Claude Code steps at the top of Klips."
        raise RuntimeError(f"Claude Code error: {message[-500:]}")
    output = data.get("structured_output")
    if output is None:
        output = _extract_json(str(data.get("result", "")))
    return schema.model_validate(output)


def _parse_api(system: str, user: str, schema):
    response = anthropic.Anthropic().messages.parse(
        model=MODEL,
        max_tokens=16000,
        thinking={"type": "adaptive"},
        system=system,
        messages=[{"role": "user", "content": user}],
        output_format=schema,
    )
    if response.stop_reason == "refusal" or response.parsed_output is None:
        raise RuntimeError(f"Claude did not return a result (stop_reason={response.stop_reason})")
    return response.parsed_output


def transcript_lines(words: List[dict]) -> str:
    lines, cur = [], []

    def flush():
        if cur:
            lines.append(f"[{cur[0]['start']:.1f}-{cur[-1]['end']:.1f}] " + " ".join(x["text"] for x in cur))
            cur.clear()

    for w in words:
        cur.append(w)
        if len(cur) >= 14 or w["text"][-1:] in ".?!":
            flush()
    flush()
    return "\n".join(lines)


def chapters(words: List[dict]) -> List[List[dict]]:
    if not words or words[-1]["end"] <= CHAPTER_THRESHOLD:
        return [words]
    out, start = [], 0.0
    while start < words[-1]["end"]:
        end = start + CHAPTER_LEN
        out.append([w for w in words if start <= w["start"] < end])
        start = end - CHAPTER_OVERLAP
    return [c for c in out if c]


def virality(scores: Scores) -> int:
    return round(0.35 * scores.hook + 0.30 * scores.payoff + 0.20 * scores.clarity + 0.15 * scores.emotion)


def _topic_line(topic: Optional[str]) -> str:
    return f"\nOnly choose clips about: {topic}. Skip moments unrelated to this.\n" if topic else ""


def find_candidates(words: List[dict], n_clips: int, min_s: float, max_s: float, topic: Optional[str] = None,
                    log: Callable[[str], None] = print) -> List[dict]:
    parts = chapters(words)
    per_chapter = max(3, math.ceil(n_clips * 1.5 / len(parts)) + 1)
    log(f"Scanning {len(parts)} chapter(s) for clip candidates...")

    def scan(chapter):
        user = (f"Find up to {per_chapter} clips, each between {min_s:g} and {max_s:g} seconds long.{_topic_line(topic)}\n"
                f"<transcript>\n{transcript_lines(chapter)}\n</transcript>")
        return _parse(CANDIDATE_PROMPT, user, CandidateList).clips

    with ThreadPoolExecutor(max_workers=2) as pool:
        found = [c for chunk in pool.map(scan, parts) for c in chunk]

    candidates = []
    for i, c in enumerate(found):
        d = c.model_dump()
        d.update(id=i, virality_score=virality(c.scores))
        candidates.append(d)
    if len(parts) == 1 and len(candidates) <= n_clips:
        return sorted(candidates, key=lambda c: -c["virality_score"])

    log(f"Re-ranking {len(candidates)} candidates across the whole video...")
    listing = "\n\n".join(
        f"<candidate id=\"{c['id']}\" start=\"{c['start']:.1f}\" end=\"{c['end']:.1f}\">\n"
        f"title: {c['title']}\nhook: {c['hook']}\nreason: {c['reason']}\n"
        f"text: {' '.join(w['text'] for w in words if c['start'] - 0.5 <= w['start'] <= c['end'])}\n</candidate>"
        for c in candidates)
    ranking = _parse(RANK_PROMPT, f"Pick the best {n_clips}.{_topic_line(topic)}\n\n{listing}", Ranking)
    by_id = {c["id"]: c for c in candidates}
    ranked = [by_id[i] for i in dict.fromkeys(ranking.ranked_ids) if i in by_id]
    return ranked[:n_clips]


def package_clips(clips: List[dict], log: Callable[[str], None] = print) -> None:
    """Adds cold open, emphasis, emoji and post copy to each clip (mutates `clips`).

    Each clip must have a `words` list (clip-relative indices)."""
    if not clips:
        return
    log("Writing hooks, emphasis words and post copy...")
    blocks = []
    for c in clips:
        indexed = " ".join(f"{i}:{w['text']}" for i, w in enumerate(c["words"]))
        blocks.append(f"<clip id=\"{c['id']}\" duration=\"{c['words'][-1]['end'] - c['words'][0]['start']:.1f}s\" "
                      f"title=\"{c['title']}\">\n{indexed}\n</clip>")
    result = _parse(PACKAGE_PROMPT, "\n\n".join(blocks), PackageList)
    by_id = {p.clip_id: p for p in result.packages}
    for c in clips:
        p = by_id.get(c["id"])
        n = len(c["words"])
        valid_open = p is not None and 0 <= p.cold_open_start <= p.cold_open_end < n
        c["cold_open"] = [p.cold_open_start, p.cold_open_end] if valid_open else None
        c["emphasis"] = sorted({i for i in (p.emphasis if p else []) if 0 <= i < n})
        c["emojis"] = {str(e.word_index): e.emoji for e in (p.emojis if p else []) if 0 <= e.word_index < n}
        c["post"] = {
            "title": (p.title if p else "") or c["title"],
            "description": p.description if p else "",
            "tiktok_caption": p.tiktok_caption if p else c["title"],
            "shorts_title": p.shorts_title if p else c["title"],
            "hashtags": normalize_hashtags(p.hashtags) if p else [],
        }
