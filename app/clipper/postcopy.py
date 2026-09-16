"""Post copy helpers: hashtag cleanup and the full description with the brand link."""
from __future__ import annotations

import re
from typing import Iterable, List

DEFAULT_LINK_URL = "https://www.patreon.com/c/kirbychan/posts"
DEFAULT_LINK_TEXT = "Get the full breakdowns and bonus content on Patreon:"


def normalize_hashtags(tags: Iterable[str], limit: int = 8) -> List[str]:
    out, seen = [], set()
    for tag in tags:
        clean = re.sub(r"[^\w]", "", str(tag).replace("#", ""))
        if clean and clean.lower() not in seen:
            seen.add(clean.lower())
            out.append(f"#{clean}")
    return out[:limit]


def full_description(clip: dict, brand: dict) -> str:
    """Description ready to paste: Claude's description, then the brand link, then hashtags."""
    post = clip.get("post") or {}
    parts = [(post.get("description") or post.get("tiktok_caption") or clip.get("title") or "").strip()]
    url = (brand.get("link_url") or "").strip()
    if url:
        parts.append(f"{(brand.get('link_text') or '').strip()} {url}".strip())
    tags = " ".join(post.get("hashtags") or [])
    if tags:
        parts.append(tags)
    return "\n\n".join(p for p in parts if p)


def post_title(clip: dict) -> str:
    post = clip.get("post") or {}
    return post.get("title") or post.get("shorts_title") or clip.get("title", "")


def copy_sheet(clip: dict, brand: dict) -> str:
    """Plain-text sheet with everything needed to publish one clip."""
    post = clip.get("post") or {}
    return "\n".join([
        f"TITLE\n{post_title(clip)}",
        "",
        f"DESCRIPTION\n{full_description(clip, brand)}",
        "",
        f"HASHTAGS\n{' '.join(post.get('hashtags') or [])}",
        "",
        f"TIKTOK / REELS CAPTION\n{post.get('tiktok_caption', clip.get('title', ''))} {' '.join(post.get('hashtags') or [])}".rstrip(),
        "",
        f"YOUTUBE SHORTS TITLE\n{post.get('shorts_title', post_title(clip))}",
        "",
    ])
