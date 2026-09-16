"""Animated captions and overlays (hook, CTA, logo) rendered with Pillow and blended onto frames."""
from __future__ import annotations

from functools import lru_cache
from typing import List, Optional

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from .config import emoji_font, load_font

WHITE, BLACK = (255, 255, 255), (0, 0, 0)

PRESETS = {
    "pop": {"label": "Bold Pop", "font": "Arial Black", "size": 84, "case": "upper", "words_per_line": 3,
            "mode": "highlight", "color": WHITE, "accent": (255, 212, 0), "emph": (255, 212, 0),
            "stroke": 8, "shadow": True, "glow": None, "pop": True},
    "box": {"label": "Bold Box", "font": "Avenir Next Heavy", "size": 80, "case": "upper", "words_per_line": 3,
            "mode": "box", "color": WHITE, "accent": (40, 200, 90), "emph": (255, 230, 0),
            "stroke": 6, "shadow": True, "glow": None, "pop": True},
    "minimal": {"label": "Minimal", "font": "Avenir Next Medium", "size": 62, "case": "lower", "words_per_line": 6,
                "mode": "static", "color": WHITE, "accent": WHITE, "emph": WHITE,
                "stroke": 0, "shadow": True, "glow": None, "pop": False},
    "karaoke": {"label": "Karaoke Fill", "font": "Futura Bold", "size": 78, "case": "upper", "words_per_line": 4,
                "mode": "karaoke", "color": WHITE, "accent": (0, 229, 255), "emph": (255, 212, 0),
                "stroke": 7, "shadow": True, "glow": None, "pop": False},
    "neon": {"label": "Neon Glow", "font": "DIN Condensed", "size": 118, "case": "upper", "words_per_line": 3,
             "mode": "highlight", "color": WHITE, "accent": (0, 255, 240), "emph": (255, 90, 230),
             "stroke": 0, "shadow": False, "glow": (255, 0, 200), "pop": True},
}
DEFAULT_PRESET = "pop"


def hex_to_rgb(value) -> tuple:
    if isinstance(value, (tuple, list)):
        return tuple(value)
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def group_words(words: List[dict], per_line: int) -> List[dict]:
    """Caption pages: up to `per_line` words, breaking on punctuation and pauses."""
    groups, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        if len(cur) >= per_line or w["text"][-1:] in ".?!," or nxt is None or nxt["start"] - w["end"] > 0.5:
            groups.append(cur)
            cur = []
    pages = []
    for k, g in enumerate(groups):
        end = g[-1]["end"]
        if k + 1 < len(groups):
            gap = groups[k + 1][0]["start"] - end
            if gap < 0.35:  # avoid flicker between pages
                end = groups[k + 1][0]["start"]
        else:
            end += 0.2
        pages.append({"start": g[0]["start"], "end": end, "words": g})
    return pages


def blend(dst: np.ndarray, rgba: np.ndarray, x: int, y: int, opacity: float = 1.0) -> None:
    """Alpha-blend an RGBA image onto a BGR frame in place."""
    h, w = rgba.shape[:2]
    H, W = dst.shape[:2]
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    if x0 >= x1 or y0 >= y1 or opacity <= 0:
        return
    src = rgba[y0 - y:y1 - y, x0 - x:x1 - x]
    a = src[..., 3:4].astype(np.float32) * (opacity / 255.0)
    roi = dst[y0:y1, x0:x1]
    roi[:] = (src[..., 2::-1].astype(np.float32) * a + roi.astype(np.float32) * (1 - a)).astype(np.uint8)


@lru_cache(maxsize=64)
def emoji_image(emoji: str, size: int) -> Optional[Image.Image]:
    font = emoji_font()
    if font is None:
        return None
    img = Image.new("RGBA", (220, 220))
    ImageDraw.Draw(img).text((10, 10), emoji, font=font, embedded_color=True)
    box = img.getbbox()
    if not box:
        return None
    img = img.crop(box)
    return img.resize((size, int(size * img.height / img.width)), Image.LANCZOS)


class CaptionRenderer:
    def __init__(self, words: List[dict], preset: str, out_w: int, out_h: int, platform: dict,
                 brand: Optional[dict] = None):
        p = dict(PRESETS.get(preset, PRESETS[DEFAULT_PRESET]))
        brand = brand or {}
        if brand.get("font"):
            p["font"] = brand["font"]
        if brand.get("accent"):
            p["accent"] = hex_to_rgb(brand["accent"])
        self.p = p
        self.scale = out_w / 1080
        usable_w = out_w * (1 - platform["safe_right"])
        self.max_w = int(usable_w - 140 * self.scale)
        self.center_x = int(out_w / 2 - out_w * platform["safe_right"] * 0.3)
        self.bottom_y = int(out_h * (1 - platform["safe_bottom"]))
        self.pages = group_words(words, p["words_per_line"])
        self._cache: dict = {}

    def overlay(self, t: float):
        """(rgba, x, y) for time t on the output timeline, or None."""
        for n, page in enumerate(self.pages):
            if page["start"] <= t < page["end"]:
                break
        else:
            return None
        active = max((k for k, w in enumerate(page["words"]) if w["start"] <= t), default=-1)
        pop = 1.0
        if self.p["pop"]:
            age = t - page["start"]
            pop = 1.0 if age >= 0.12 else round((0.8 + 0.2 * age / 0.12) * 20) / 20
        key = (n, active, pop)
        if key not in self._cache:
            if len(self._cache) > 48:
                self._cache.clear()
            img = self._render(page["words"], active)
            if pop != 1.0:
                img = img.resize((max(1, int(img.width * pop)), max(1, int(img.height * pop))), Image.BILINEAR)
            self._cache[key] = np.array(img)
        arr = self._cache[key]
        return arr, self.center_x - arr.shape[1] // 2, self.bottom_y - arr.shape[0]

    def _text(self, w: dict) -> str:
        case = self.p["case"]
        return w["text"].upper() if case == "upper" else w["text"].lower() if case == "lower" else w["text"]

    def _render(self, words: List[dict], active: int) -> Image.Image:
        p, s = self.p, self.scale
        base = int(p["size"] * s)
        stroke = int(p["stroke"] * s)
        space = load_font(p["font"], base).getlength(" ")
        line_h = int(base * 1.22)

        items = []
        for k, w in enumerate(words):
            emphasised = w.get("emphasis") and p["mode"] != "static"
            font = load_font(p["font"], int(base * (1.15 if emphasised else 1.0)))
            text = self._text(w)
            l, t, r, b = font.getbbox(text, anchor="ls", stroke_width=stroke)
            color = p["color"]
            if emphasised:
                color = p["emph"]
            if (p["mode"] == "highlight" and k == active) or (p["mode"] == "karaoke" and k <= active):
                color = p["accent"]
            items.append({"text": text, "font": font, "w": r - l, "color": color, "box": p["mode"] == "box" and k == active})

        lines, cur, cur_w = [], [], 0.0
        for it in items:
            add = it["w"] + (space if cur else 0)
            if cur and cur_w + add > self.max_w:
                lines.append((cur, cur_w))
                cur, cur_w = [], 0.0
                add = it["w"]
            cur.append(it)
            cur_w += add
        if cur:
            lines.append((cur, cur_w))

        emoji = next((w["emoji"] for w in words if w.get("emoji")), None)
        emoji_img = emoji_image(emoji, int(base * 1.3)) if emoji else None
        pad = stroke + int(40 * s)
        top = (emoji_img.height + int(10 * s)) if emoji_img else 0
        width = int(max(lw for _, lw in lines)) + 2 * pad
        height = top + line_h * len(lines) + 2 * pad

        def draw_layer(fill=None, extra_stroke=0):
            layer = Image.new("RGBA", (width, height))
            d = ImageDraw.Draw(layer)
            for row, (line, lw) in enumerate(lines):
                x = pad + (width - 2 * pad - lw) / 2
                baseline = pad + top + row * line_h + base
                for it in line:
                    if it["box"] and fill is None:
                        bp = int(14 * s)
                        d.rounded_rectangle((x - bp, baseline - base * 0.95 - bp / 2, x + it["w"] + bp, baseline + base * 0.18 + bp / 2),
                                            radius=int(18 * s), fill=p["accent"] + (255,))
                    d.text((x, baseline), it["text"], font=it["font"], anchor="ls",
                           fill=(fill or it["color"]) + (255,),
                           stroke_width=stroke + extra_stroke, stroke_fill=(fill or BLACK) + (255,))
                    x += it["w"] + space
            return layer

        canvas = Image.new("RGBA", (width, height))
        if p["shadow"]:
            shadow = draw_layer(fill=BLACK).filter(ImageFilter.GaussianBlur(8 * s))
            shadow.putalpha(shadow.getchannel("A").point(lambda v: int(v * 0.6)))
            canvas.alpha_composite(shadow, (0, int(6 * s)))
        if p["glow"]:
            glow = draw_layer(fill=p["glow"], extra_stroke=int(6 * s)).filter(ImageFilter.GaussianBlur(16 * s))
            canvas.alpha_composite(glow)
            canvas.alpha_composite(glow)
        canvas.alpha_composite(draw_layer())
        if emoji_img:
            canvas.alpha_composite(emoji_img, ((width - emoji_img.width) // 2, pad))
        return canvas


def _pill(text: str, font_name: str, size: int, max_w: int, bg: tuple, fg: tuple, radius: int) -> np.ndarray:
    font = load_font(font_name, size)
    words, lines, cur = text.split(), [], ""
    for word in words:
        trial = f"{cur} {word}".strip()
        if cur and font.getlength(trial) > max_w:
            lines.append(cur)
            cur = word
        else:
            cur = trial
    if cur:
        lines.append(cur)
    pad_x, pad_y, line_h = int(size * 0.6), int(size * 0.35), int(size * 1.2)
    width = int(max(font.getlength(line) for line in lines)) + 2 * pad_x
    height = line_h * len(lines) + 2 * pad_y
    img = Image.new("RGBA", (width, height))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, width - 1, height - 1), radius=radius, fill=bg + (255,))
    for i, line in enumerate(lines):
        d.text((width / 2, pad_y + i * line_h + line_h / 2), line, font=font, anchor="mm", fill=fg + (255,))
    return np.array(img)


def render_hook(text: str, out_w: int, brand: Optional[dict] = None) -> np.ndarray:
    brand = brand or {}
    s = out_w / 1080
    bg = hex_to_rgb(brand.get("primary", "#FFFFFF"))
    fg = BLACK if sum(bg) > 380 else WHITE
    return _pill(text.upper(), brand.get("font") or "Arial Black", int(58 * s), int(out_w * 0.72), bg, fg, int(22 * s))


def render_cta(text: str, out_w: int, brand: Optional[dict] = None) -> np.ndarray:
    brand = brand or {}
    s = out_w / 1080
    bg = hex_to_rgb(brand.get("accent", "#FFD400"))
    fg = BLACK if sum(bg) > 380 else WHITE
    return _pill(text, brand.get("font") or "Arial Black", int(52 * s), int(out_w * 0.7), bg, fg, int(60 * s))


def load_logo(path: str, out_w: int) -> Optional[np.ndarray]:
    try:
        img = Image.open(path).convert("RGBA")
    except (OSError, ValueError):
        return None
    target = int(out_w * 0.16)
    img = img.resize((target, max(1, int(img.height * target / img.width))), Image.LANCZOS)
    return np.array(img)
