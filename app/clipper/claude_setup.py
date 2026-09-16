"""Set up Claude Code on a new computer from inside Klips.

Klips uses the customer's own Claude subscription through the Claude Code CLI. On a fresh computer
this module installs Claude Code with Anthropic's official installer, opens a window for signing in,
and reports progress to the app so nobody has to find a terminal command in a README.
"""
from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
import threading
from pathlib import Path

from .config import DATA_DIR, no_window

INSTALL_LOG = DATA_DIR / "claude-code-install.log"

# Anthropic's official installers: https://code.claude.com/docs/en/setup
MAC_LINUX_COMMAND = "curl -fsSL https://claude.ai/install.sh | bash"
WINDOWS_COMMAND = "irm https://claude.ai/install.ps1 | iex"

_install = {"state": "idle", "error": ""}  # idle | running | done | failed
_lock = threading.Lock()


def platform_id() -> str:
    if sys.platform == "win32":
        return "windows"
    return "mac" if sys.platform == "darwin" else "linux"


def install_command() -> str:
    return WINDOWS_COMMAND if platform_id() == "windows" else MAC_LINUX_COMMAND


def candidate_paths() -> list:
    """Where Claude Code ends up. Apps opened from Finder or the Start menu don't see the shell's PATH."""
    home = Path.home()
    if platform_id() == "windows":
        appdata = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming"))
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
        return [
            home / ".local" / "bin" / "claude.exe",  # native installer
            local / "Microsoft" / "WinGet" / "Links" / "claude.exe",  # winget
            appdata / "npm" / "claude.cmd",  # npm
        ]
    return [
        home / ".local" / "bin" / "claude",  # native installer
        home / ".claude" / "local" / "claude",  # older local installs
        Path("/opt/homebrew/bin/claude"),  # Homebrew, Apple Silicon
        Path("/usr/local/bin/claude"),  # Homebrew, Intel / npm
        home / ".npm-global" / "bin" / "claude",
        Path("/usr/bin/claude"),  # apt / dnf
    ]


def find_claude():
    found = shutil.which("claude")
    if found:
        return found
    for path in candidate_paths():
        if path.exists():
            return str(path)
    return None


def install_state() -> dict:
    with _lock:
        state = dict(_install)
    try:
        lines = INSTALL_LOG.read_text(errors="replace").splitlines()
        state["log"] = "\n".join(lines[-12:])
    except OSError:
        state["log"] = ""
    return state


def start_install() -> dict:
    """Run the official installer in the background. Safe to call twice: a running install is left alone."""
    with _lock:
        if _install["state"] == "running":
            return dict(_install)
        _install.update(state="running", error="")
    threading.Thread(target=_run_install, daemon=True).start()
    return install_state()


def _run_install() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if platform_id() == "windows":
        cmd = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_COMMAND]
    else:
        cmd = ["/bin/bash", "-c", MAC_LINUX_COMMAND]
    try:
        with open(INSTALL_LOG, "w", encoding="utf-8") as log:
            log.write(f"Installing Claude Code with: {install_command()}\n")
            log.flush()
            proc = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                  timeout=900, **no_window())
        ok = proc.returncode == 0 and find_claude() is not None
        error = "" if ok else "The installer didn't finish. Details are below; you can also install it yourself."
    except (OSError, subprocess.TimeoutExpired) as e:
        ok, error = False, f"The installer couldn't run ({e}). Try installing it yourself with the command below."
    with _lock:
        _install.update(state="done" if ok else "failed", error=error)


def open_sign_in() -> None:
    """Open a terminal window running `claude auth login`, which walks through signing in in the browser."""
    exe = find_claude()
    if not exe:
        raise RuntimeError("Install Claude Code first.")
    system = platform_id()
    if system == "windows":
        subprocess.Popen(["cmd.exe", "/k", exe, "auth", "login"], creationflags=subprocess.CREATE_NEW_CONSOLE)
        return
    command = f"{shlex.quote(exe)} auth login"
    if system == "mac":
        script = command.replace("\\", "\\\\").replace('"', '\\"')
        subprocess.run(["osascript", "-e", 'tell application "Terminal"', "-e", "activate",
                        "-e", f'do script "{script}"', "-e", "end tell"], check=True, timeout=30)
        return
    for terminal in (["x-terminal-emulator", "-e"], ["gnome-terminal", "--"], ["konsole", "-e"], ["xterm", "-e"]):
        if shutil.which(terminal[0]):
            subprocess.Popen([*terminal, "bash", "-c", f"{command}; exec bash"])
            return
    raise RuntimeError("Couldn't open a terminal. Open one yourself and run: claude auth login")
