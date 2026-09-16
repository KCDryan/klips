"""Edit decisions: word-boundary snapping, filler/silence removal, cold opens, output timeline."""
from __future__ import annotations

import re
from typing import List, Optional, Sequence, Tuple

FILLERS = {"um", "uh", "erm", "er", "ah", "hmm", "uhm", "mm", "umm", "uhh"}
MAX_GAP = 0.4        # silences longer than this get cut
LEAD, TAIL = 0.08, 0.08  # breathing room kept around each cut
END_TAIL = 0.3


def _norm(text: str) -> str:
    return re.sub(r"[^a-z']", "", text.lower())


def filler_indices(words: Sequence[dict]) -> set:
    out = set()
    for i, w in enumerate(words):
        if _norm(w["text"]) in FILLERS:
            out.add(i)
        # "you know," used as a verbal tic (followed by a comma), not "do you know what..."
        if (_norm(w["text"]) == "know" and w["text"].endswith(",") and i > 0
                and _norm(words[i - 1]["text"]) == "you"):
            out.update({i - 1, i})
    return out


def snap_range(start: float, end: float, words: Sequence[dict], min_s: float, max_s: float) -> Optional[Tuple[int, int]]:
    """Word index range [i0, i1] covering start..end, trimmed to max_s at a sentence end when possible."""
    idx = [i for i, w in enumerate(words) if w["start"] >= start - 0.5 and w["end"] <= end + 0.5]
    if not idx:
        return None
    i0, i1 = idx[0], idx[-1]
    if words[i1]["end"] - words[i0]["start"] > max_s:
        fits = [i for i in idx if words[i]["end"] - words[i0]["start"] <= max_s]
        if not fits:
            return None
        sentence_ends = [i for i in fits if words[i]["text"][-1:] in ".?!"]
        i1 = (sentence_ends or fits)[-1]
    if words[i1]["end"] - words[i0]["start"] < min_s * 0.6:
        return None
    return i0, i1


def keep_ranges(words: Sequence[dict], removed: set) -> List[Tuple[float, float]]:
    """Source-time ranges to keep, cutting removed words and long silences."""
    ranges: List[List[float]] = []
    prev = None
    for i, w in enumerate(words):
        if i in removed:
            continue
        # Extend the current range only when nothing was removed in between and the pause is short.
        if prev is not None and i == prev + 1 and w["start"] - words[prev]["end"] <= MAX_GAP:
            ranges[-1][1] = w["end"]
        else:
            if ranges:
                ranges[-1][1] += TAIL
            ranges.append([max(0.0, w["start"] - LEAD), w["end"]])
        prev = i
    if ranges:
        ranges[-1][1] += END_TAIL
    merged: List[List[float]] = []
    for r in ranges:
        if merged and r[0] <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], r[1])
        else:
            merged.append(list(r))
    return [(round(a, 3), round(b, 3)) for a, b in merged]


def build_edit(words: Sequence[dict], deleted: Sequence[int] = (), remove_fillers: bool = True,
               cold_open: Optional[Sequence[int]] = None, emphasis: Sequence[int] = (),
               emojis: Optional[dict] = None) -> dict:
    """Plan the output timeline for one clip.

    `words` are the clip's words (clip-relative indices). Returns segments in output order and the
    words re-timed onto the output timeline, ready for captions.
    """
    emojis = emojis or {}
    removed = set(deleted) | (filler_indices(words) if remove_fillers else set())
    emphasis = set(emphasis)

    segments = []
    if cold_open:
        a, b = cold_open
        segments.append({"src_start": max(0.0, words[a]["start"] - 0.05), "src_end": words[b]["end"] + 0.2,
                         "cold_open": True, "words": [i for i in range(a, b + 1) if i not in removed]})
    for s, e in keep_ranges(words, removed):
        inside = [i for i, w in enumerate(words)
                  if i not in removed and s <= (w["start"] + w["end"]) / 2 <= e]
        segments.append({"src_start": s, "src_end": e, "cold_open": False, "words": inside})

    out_words, t = [], 0.0
    for seg in segments:
        seg["out_start"] = round(t, 3)
        for i in seg["words"]:
            w = words[i]
            out_words.append({
                "i": i, "text": w["text"],
                "start": round(t + w["start"] - seg["src_start"], 3),
                "end": round(t + min(w["end"], seg["src_end"]) - seg["src_start"], 3),
                "emphasis": i in emphasis, "emoji": emojis.get(str(i)),
            })
        t += seg["src_end"] - seg["src_start"]
        del seg["words"]
    return {"segments": segments, "words": out_words, "duration": round(t, 3)}


def remove_overlaps(clips: List[dict]) -> List[dict]:
    kept = []
    for c in clips:
        if all(c["start"] >= k["end"] or c["end"] <= k["start"] for k in kept):
            kept.append(c)
    return kept
