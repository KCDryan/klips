"""Klips Engine: the background service that klips.pro/studio drives.

The studio runs in the customer's browser at klips.pro; the video work runs here, on their own
computer, with their own Claude Code. The engine listens only on 127.0.0.1 and only obeys pages
served from klips.pro, so other websites can't use it.
"""
from __future__ import annotations

import os
import plistlib
import sys
from pathlib import Path

from .klips_cloud import API_BASE

# The studio looks for the engine on the first of these ports that answers.
PORTS = tuple(range(47813, 47818))
SITE_ORIGINS = ("https://klips.pro", "https://www.klips.pro")
MAC_AGENT_LABEL = "pro.klips.engine"
WINDOWS_RUN_VALUE = "Klips Engine"


def allowed_origins() -> set:
    """klips.pro, plus any extra origins for local development (KLIPS_ALLOWED_ORIGINS, comma separated)."""
    extra = {o.strip().rstrip("/") for o in os.environ.get("KLIPS_ALLOWED_ORIGINS", "").split(",") if o.strip()}
    return set(SITE_ORIGINS) | extra


def studio_url() -> str:
    return f"{API_BASE}/studio/"


def _mac_agent_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{MAC_AGENT_LABEL}.plist"


def install_autostart(executable: str) -> str:
    """Start the engine quietly at login. Returns what happened, for the log."""
    if sys.platform == "darwin":
        # Only from a real install: an app run straight from the disk image lives at a temporary path.
        if "/Applications/" not in executable or "AppTranslocation" in executable:
            return "autostart skipped: move Klips to Applications to start it at login"
        plist = {
            "Label": MAC_AGENT_LABEL,
            "ProgramArguments": [executable, "--background"],
            "RunAtLoad": True,
            "LimitLoadToSessionType": "Aqua",
        }
        path = _mac_agent_path()
        data = plistlib.dumps(plist)
        if path.exists() and path.read_bytes() == data:
            return "autostart already set"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return f"autostart set: {path}"
    if sys.platform == "win32":
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0,
                            winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, WINDOWS_RUN_VALUE, 0, winreg.REG_SZ, f'"{executable}" --background')
        return "autostart set in the Windows Run key"
    desktop = Path.home() / ".config" / "autostart" / "klips-engine.desktop"
    desktop.parent.mkdir(parents=True, exist_ok=True)
    desktop.write_text(f"[Desktop Entry]\nType=Application\nName=Klips Engine\nExec=\"{executable}\" --background\n"
                       "X-GNOME-Autostart-enabled=true\n")
    return f"autostart set: {desktop}"
