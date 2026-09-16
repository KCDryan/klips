import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from clipper import captions, edit, pipeline, reframe, render  # noqa: E402


def words_from(text, gap=0.1, dur=0.3, start=0.0, pauses=None):
    pauses = pauses or {}
    out, t = [], start
    for i, token in enumerate(text.split()):
        t += pauses.get(i, 0.0)
        out.append({"text": token, "start": round(t, 2), "end": round(t + dur, 2)})
        t += dur + gap
    return out


# ---- edit ----

def test_snap_range_trims_to_last_sentence_that_fits():
    w = words_from("One two three. Four five six seven eight nine ten eleven twelve.")
    span = edit.snap_range(0, 100, w, min_s=1, max_s=2.5)
    assert span == (0, 2)  # stops at "three." instead of mid-sentence


def test_snap_range_rejects_too_short():
    w = words_from("Hi there.")
    assert edit.snap_range(0, 10, w, min_s=20, max_s=60) is None


def test_filler_indices():
    w = words_from("So um I think, you know, it works and do you know why")
    idx = edit.filler_indices(w)
    assert 1 in idx            # um
    assert {4, 5} <= idx       # "you know,"
    assert 10 not in idx and 11 not in idx  # "do you know why" is kept


def test_keep_ranges_cut_fillers_and_long_silences():
    w = words_from("Hello um world this is great", pauses={4: 1.5})
    ranges = edit.keep_ranges(w, removed={1})
    assert len(ranges) == 3  # cut at "um", cut at the 1.5 s pause
    for (a0, a1), (b0, b1) in zip(ranges, ranges[1:]):
        assert a1 <= b0


def test_build_edit_retimes_words_and_prepends_cold_open():
    w = words_from("Intro words here. Then the big line lands now.")
    plan = edit.build_edit(w, remove_fillers=False, cold_open=[3, 8], emphasis=[6], emojis={"6": "🔥"})
    assert plan["segments"][0]["cold_open"] is True
    total = sum(s["src_end"] - s["src_start"] for s in plan["segments"])
    assert abs(total - plan["duration"]) < 1e-6
    starts = [x["start"] for x in plan["words"]]
    assert starts == sorted(starts)
    assert plan["words"][0]["text"] == "Then"
    assert any(x["emphasis"] and x["emoji"] == "🔥" for x in plan["words"])


def test_build_edit_deleted_words_are_removed():
    w = words_from("keep drop keep")
    plan = edit.build_edit(w, deleted=[1], remove_fillers=False)
    assert [x["text"] for x in plan["words"]] == ["keep", "keep"]


def test_remove_overlaps_keeps_higher_ranked_first():
    clips = [{"start": 10, "end": 40}, {"start": 30, "end": 60}, {"start": 60, "end": 80}]
    assert edit.remove_overlaps(clips) == [clips[0], clips[2]]


# ---- captions ----

def test_group_words_breaks_on_punctuation_and_size():
    w = words_from("one two three four. five")
    pages = captions.group_words(w, per_line=3)
    assert [len(p["words"]) for p in pages] == [3, 1, 1]
    for a, b in zip(pages, pages[1:]):
        assert a["end"] <= b["start"] + 1e-9


def test_blend_clips_to_frame_bounds():
    frame = np.zeros((10, 10, 3), np.uint8)
    rgba = np.full((6, 6, 4), 255, np.uint8)
    captions.blend(frame, rgba, 7, -2)
    assert frame[0, 9].tolist() == [255, 255, 255]
    assert frame[9, 0].tolist() == [0, 0, 0]


# ---- reframe ----

def test_crop_box_keeps_target_aspect_and_stays_in_frame():
    x0, y0, w, h = reframe.crop_box(1900, 540, 1080, 1920, 1920, 1080)
    assert (y0, h) == (0, 1080)
    assert abs(w / h - 1080 / 1920) < 0.01
    assert x0 + w <= 1920


def _sample(t, faces, audio=0.5, cut=False):
    return {"t": t, "cut": cut, "audio": audio, "faces": faces}


def test_plan_shots_letterbox_without_faces():
    analysis = {"start": 0, "end": 4, "src_w": 1920, "src_h": 1080,
                "samples": [_sample(i / 10, []) for i in range(40)]}
    reframe.assign_speakers(analysis["samples"])
    shots = reframe.plan_shots(analysis, words_from("no faces here at all."))
    assert [s["type"] for s in shots] == ["letterbox"]


def test_plan_shots_split_when_speakers_trade_lines():
    samples = []
    for i in range(60):
        left_talks = (i // 15) % 2 == 0  # speakers trade lines every 1.5 seconds
        samples.append(_sample(i / 10, [
            {"track": 0, "cx": 500, "cy": 400, "w": 200, "h": 200, "motion": 9 if left_talks else 0},
            {"track": 1, "cx": 1400, "cy": 400, "w": 200, "h": 200, "motion": 0 if left_talks else 9},
        ]))
    reframe.assign_speakers(samples)
    analysis = {"start": 0, "end": 6, "src_w": 1920, "src_h": 1080, "samples": samples}
    shots = reframe.plan_shots(analysis, words_from("a quick back and forth exchange between two people"))
    assert shots[0]["type"] == "split"
    assert shots[0]["tracks"] == [0, 1]


def test_plan_shots_tracks_single_speaker():
    samples = [_sample(i / 10, [{"track": 3, "cx": 700, "cy": 400, "w": 200, "h": 200, "motion": 5}]) for i in range(40)]
    reframe.assign_speakers(samples)
    shots = reframe.plan_shots({"start": 0, "end": 4, "src_w": 1920, "src_h": 1080, "samples": samples},
                               words_from("just one person talking."))
    assert shots[0]["type"] == "track" and shots[0]["tracks"] == [3]
    assert 690 <= shots[0]["paths"][0]["x"][0] <= 710


# ---- render ----

def test_zoom_events_respect_spacing():
    w = [{"start": t, "end": t + 0.3, "emphasis": True} for t in (1.0, 3.0, 8.0)]
    assert [e[0] for e in render.zoom_events(w)] == [1.0, 8.0]
    assert render.zoom_at(1.1, render.zoom_events(w)) > 1.1
    assert render.zoom_at(5.0, render.zoom_events(w)) == 1.0


# ---- pipeline ----

def test_relative_indices_follow_in_out_changes():
    clip = {"i0": 10, "i1": 20, "deleted": [5, 12], "emphasis": [11, 25], "emojis": {"15": "💸", "30": "x"},
            "cold_open": [14, 16]}
    rel = pipeline._relative(clip)
    assert rel["deleted"] == [2]
    assert rel["emphasis"] == [1]
    assert rel["emojis"] == {"5": "💸"}
    assert rel["cold_open"] == [4, 6]
