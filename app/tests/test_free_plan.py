"""Free plan (10 watermarked clips a day), removing watermarks, and charging retries again."""
import pytest

from clipper import captions, klips_cloud, pipeline, store


@pytest.fixture
def cloud(monkeypatch):
    calls = []
    state = {"free_left": 10, "next": 0}

    def reserve(clips, source_name, source_seconds, platform_id, app_version, plan="tokens"):
        state["next"] += 1
        calls.append(("reserve", plan, clips))
        if plan == "free":
            if state["free_left"] <= 0:
                raise klips_cloud.KlipsError("You've used today's 10 free clips.")
            allowed = min(clips, state["free_left"])
            state["free_left"] -= allowed
            return {"generation_id": f"gen_{state['next']}", "plan": "free", "watermark": True,
                    "clips_allowed": allowed, "tokens_charged": 0, "tokens": 0, "free_clips_left": state["free_left"]}
        return {"generation_id": f"gen_{state['next']}", "plan": "tokens", "watermark": False,
                "clips_allowed": clips, "tokens_charged": 3 * clips, "tokens": 100}

    monkeypatch.setattr(klips_cloud, "reserve", reserve)
    monkeypatch.setattr(klips_cloud, "complete", lambda gen, n, titles=None: calls.append(("complete", gen, n)) or {})
    monkeypatch.setattr(klips_cloud, "failed", lambda gen, err: calls.append(("failed", gen)) or {})
    monkeypatch.setattr(pipeline.media, "probe", lambda path: {"duration": 600.0})
    return calls, state


def make_job(options, clips=0, status="done"):
    job_id = store.create_job("talk.mp4", {**pipeline.DEFAULT_OPTIONS, **options}, status=status)
    for idx in range(clips):
        store.put_clip(job_id, idx, {"title": f"Clip {idx + 1}", "i0": 0, "i1": 5}, status="done")
    return job_id


def test_free_runs_are_watermarked_and_capped_at_whats_left_today(cloud):
    calls, state = cloud
    state["free_left"] = 3
    job_id = make_job({"plan": "free"}, status="running")
    assert pipeline._reserve_tokens(job_id, {"plan": "free"}, 5) == 3
    options = store.get_job(job_id, with_clips=False)["options"]
    assert options["watermark"] is True and options["clips_allowed"] == 3
    assert calls[-1] == ("reserve", "free", 5)
    # resuming the same run doesn't reserve again
    assert pipeline._reserve_tokens(job_id, options, 5) == 3
    assert len([c for c in calls if c[0] == "reserve"]) == 1


def test_token_runs_have_no_watermark(cloud):
    job_id = make_job({"plan": "tokens"}, status="running")
    assert pipeline._reserve_tokens(job_id, {"plan": "tokens"}, 4) == 4
    assert store.get_job(job_id, with_clips=False)["options"]["watermark"] is False


def test_removing_a_watermark_charges_one_clip_and_refunds_a_failed_render(cloud):
    calls, _ = cloud
    job_id = make_job({"plan": "free", "watermark": True, "generation_id": "gen_run", "generation_settled": True}, clips=2)
    pipeline.remove_watermark(job_id, 0)
    clip = store.get_clip(job_id, 0)
    assert clip["watermark_removed"] is True and clip["status"] == "queued"
    assert calls[-1] == ("reserve", "tokens", 1)

    pipeline._settle_clip_charge(job_id, 0, error="render broke")
    clip = store.get_clip(job_id, 0)
    assert clip["watermark_removed"] is False and "charge_generation" not in clip
    assert calls[-1][0] == "failed"

    pipeline.remove_watermark(job_id, 1)
    pipeline._settle_clip_charge(job_id, 1)
    assert store.get_clip(job_id, 1)["watermark_removed"] is True
    assert calls[-1][0] == "complete"
    with pytest.raises(ValueError):
        pipeline.remove_watermark(job_id, 1)


def test_token_clips_have_no_watermark_to_remove(cloud):
    job_id = make_job({"plan": "tokens", "watermark": False}, clips=1)
    with pytest.raises(ValueError):
        pipeline.remove_watermark(job_id, 0)


def test_retrying_refunded_work_reserves_again(cloud):
    calls, _ = cloud
    failed_run = make_job({"plan": "tokens", "generation_id": "gen_old", "generation_settled": True, "watermark": False},
                          status="error")
    pipeline.retry(failed_run)
    options = store.get_job(failed_run, with_clips=False)["options"]
    assert "generation_id" not in options and store.get_job(failed_run, with_clips=False)["status"] == "queued"

    done_run = make_job({"plan": "free", "generation_id": "gen_old", "generation_settled": True, "watermark": True}, clips=2)
    store.update_clip(done_run, 1, status="error", error="boom")
    pipeline.retry(done_run)
    clip = store.get_clip(done_run, 1)
    assert clip["status"] == "queued" and clip["charge_kind"] == "retry"
    assert calls[-1] == ("reserve", "free", 1)


def test_watermark_image_is_a_readable_badge():
    badge = captions.render_watermark(1080)
    height, width = badge.shape[:2]
    assert badge.shape[2] == 4 and 60 <= height <= 100 and width > 2 * height
    assert badge[..., 3].max() == 255  # the yellow Klips mark is fully opaque
