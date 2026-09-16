"""Shared settings: model, paths, export presets, fonts."""
from __future__ import annotations

import os
import shutil
import sys
from functools import lru_cache
from pathlib import Path
from typing import Optional

MODEL = "claude-opus-5"

# True inside the installed app (PyInstaller). Bundled files live in a read-only folder there.
FROZEN = bool(getattr(sys, "frozen", False))
ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))


def _default_data_dir() -> Path:
    """Projects, licence and settings: next to the code when developing, the OS's app-data folder when installed."""
    if not FROZEN:
        return ROOT / "data"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Klips"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA") or Path.home()) / "Klips"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "Klips"


DATA_DIR = Path(os.environ.get("CLIPPER_DATA") or _default_data_dir())
FONTS_DIR = ROOT / "fonts"

# Export presets. safe_bottom / safe_right are the fractions of the frame covered by platform UI.
PLATFORMS = {
    "tiktok": {"label": "TikTok", "width": 1080, "height": 1920, "fps": 30, "safe_bottom": 0.22, "safe_right": 0.14},
    "reels": {"label": "Instagram Reels", "width": 1080, "height": 1920, "fps": 30, "safe_bottom": 0.22, "safe_right": 0.12},
    "shorts": {"label": "YouTube Shorts", "width": 1080, "height": 1920, "fps": 60, "safe_bottom": 0.20, "safe_right": 0.12},
    "linkedin": {"label": "LinkedIn (4:5)", "width": 1080, "height": 1350, "fps": 30, "safe_bottom": 0.10, "safe_right": 0.04},
}

_MAC, _WIN, _LINUX = "/System/Library/Fonts/", "C:/Windows/Fonts/", "/usr/share/fonts/truetype/"

# Font name -> candidate (path, weight inside a .ttc) pairs. First one that exists wins: macOS, Windows, Linux.
_SYSTEM_FONTS = {
    "Arial Black": [(_MAC + "Supplemental/Arial Black.ttf", None), (_WIN + "ariblk.ttf", None),
                    (_LINUX + "dejavu/DejaVuSans-Bold.ttf", None)],
    "Impact": [(_MAC + "Supplemental/Impact.ttf", None), (_WIN + "impact.ttf", None)],
    "Avenir Next Heavy": [(_MAC + "Avenir Next.ttc", "Heavy"), (_WIN + "segoeuib.ttf", None),
                          (_LINUX + "dejavu/DejaVuSans-Bold.ttf", None)],
    "Avenir Next Medium": [(_MAC + "Avenir Next.ttc", "Medium"), (_WIN + "segoeui.ttf", None),
                           (_LINUX + "dejavu/DejaVuSans.ttf", None)],
    "Futura Bold": [(_MAC + "Supplemental/Futura.ttc", "Bold"), (_WIN + "trebucbd.ttf", None),
                    (_LINUX + "dejavu/DejaVuSans-Bold.ttf", None)],
    "DIN Condensed": [(_MAC + "Supplemental/DIN Condensed Bold.ttf", None), (_WIN + "bahnschrift.ttf", None),
                      (_LINUX + "dejavu/DejaVuSansCondensed-Bold.ttf", None)],
    "Arial Rounded": [(_MAC + "Supplemental/Arial Rounded Bold.ttf", None), (_WIN + "ARLRDBD.TTF", None),
                      (_WIN + "arialbd.ttf", None)],
}
# Colour emoji fonts and the pixel size each renders at.
_EMOJI_FONTS = [(_MAC + "Apple Color Emoji.ttc", 160), (_WIN + "seguiemj.ttf", 136),
                (_LINUX + "noto/NotoColorEmoji.ttf", 109)]


def _first_existing(candidates: list) -> Optional[tuple]:
    return next(((path, style) for path, style in candidates if os.path.exists(path)), None)


def ffmpeg_exe() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg  # ships a full static ffmpeg build

    return imageio_ffmpeg.get_ffmpeg_exe()


def available_fonts() -> list:
    """Font names usable in presets and the brand kit: system fonts plus anything dropped in fonts/."""
    names = [n for n, candidates in _SYSTEM_FONTS.items() if _first_existing(candidates)]
    if FONTS_DIR.exists():
        names += sorted(p.stem for p in FONTS_DIR.iterdir() if p.suffix.lower() in (".ttf", ".otf"))
    return names


def no_window() -> dict:
    """subprocess kwargs that stop Windows flashing a console window for every ffmpeg or Claude call."""
    if sys.platform == "win32":
        import subprocess
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


@lru_cache(maxsize=None)
def font_source(name: str) -> tuple:
    """Resolve a font name to (path, ttc_index)."""
    from PIL import ImageFont

    if FONTS_DIR.exists():
        for p in FONTS_DIR.iterdir():
            if p.stem == name and p.suffix.lower() in (".ttf", ".otf"):
                return str(p), 0
    found = _first_existing(_SYSTEM_FONTS.get(name, [])) or next(
        (hit for candidates in _SYSTEM_FONTS.values() for hit in [_first_existing(candidates)] if hit), None)
    if not found:
        return "", 0
    path, style = found
    if style is None:
        return path, 0
    for index in range(32):  # find the requested weight inside the .ttc collection
        try:
            if ImageFont.truetype(path, 20, index=index).getname()[1] == style:
                return path, index
        except OSError:
            break
    return path, 0


@lru_cache(maxsize=256)
def load_font(name: str, size: int):
    from PIL import ImageFont

    path, index = font_source(name)
    if not path:
        return ImageFont.load_default(size)
    return ImageFont.truetype(path, size, index=index)


@lru_cache(maxsize=None)
def emoji_font() -> Optional[object]:
    from PIL import ImageFont

    for path, size in _EMOJI_FONTS:  # bitmap emoji fonts only render at their native size
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return None
