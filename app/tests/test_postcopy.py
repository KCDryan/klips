import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from clipper import postcopy  # noqa: E402

BRAND = {"link_url": postcopy.DEFAULT_LINK_URL, "link_text": postcopy.DEFAULT_LINK_TEXT}


def test_normalize_hashtags_adds_hash_strips_spaces_and_dedupes():
    tags = ["money", "#Money", "# side hustle", "#finance!"]
    assert postcopy.normalize_hashtags(tags) == ["#money", "#sidehustle", "#finance"]


def test_full_description_has_description_then_link_then_hashtags():
    clip = {"title": "t", "post": {"description": "He lost $2M in a day.", "hashtags": ["#money", "#investing"]}}
    text = postcopy.full_description(clip, BRAND)
    parts = text.split("\n\n")
    assert parts[0] == "He lost $2M in a day."
    assert parts[1].endswith("https://www.patreon.com/c/kirbychan/posts")
    assert parts[2] == "#money #investing"


def test_full_description_without_link():
    clip = {"title": "t", "post": {"description": "Desc.", "hashtags": []}}
    assert postcopy.full_description(clip, {"link_url": ""}) == "Desc."


def test_copy_sheet_falls_back_for_clips_without_new_fields():
    clip = {"title": "Old clip title", "post": {"tiktok_caption": "cap", "shorts_title": "Short", "hashtags": ["#a"]}}
    sheet = postcopy.copy_sheet(clip, BRAND)
    assert "TITLE\nShort" in sheet
    assert "patreon.com/c/kirbychan/posts" in sheet
