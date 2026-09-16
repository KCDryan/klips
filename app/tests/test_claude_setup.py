"""Claude Code setup on a fresh computer: finding it, installing it, and reporting status."""
import time

from clipper import claude_setup, picker


def test_finds_claude_in_the_native_install_folder_without_path(tmp_path, monkeypatch):
    monkeypatch.setattr(claude_setup.shutil, "which", lambda name: None)
    monkeypatch.setattr(claude_setup.Path, "home", classmethod(lambda cls: tmp_path))
    assert claude_setup.find_claude() is None
    name = "claude.exe" if claude_setup.platform_id() == "windows" else "claude"
    binary = tmp_path / ".local" / "bin" / name
    binary.parent.mkdir(parents=True)
    binary.write_text("")
    assert claude_setup.find_claude() == str(binary)


def test_status_walks_through_install_then_sign_in(monkeypatch):
    monkeypatch.setattr(picker, "backend", lambda: "claude-code")
    monkeypatch.setattr(claude_setup, "find_claude", lambda: None)
    status = picker.llm_status()
    assert status["ready"] is False and status["installed"] is False
    assert "install" in status["install_command"]

    monkeypatch.setattr(claude_setup, "find_claude", lambda: "/fake/claude")
    monkeypatch.setattr(picker, "claude_logged_in", lambda exe: False)
    status = picker.llm_status()
    assert status["installed"] is True and status["logged_in"] is False and status["ready"] is False

    monkeypatch.setattr(picker, "claude_logged_in", lambda exe: True)
    assert picker.llm_status()["ready"] is True


def test_install_reports_failure_with_its_log(tmp_path, monkeypatch):
    monkeypatch.setattr(claude_setup, "DATA_DIR", tmp_path)
    monkeypatch.setattr(claude_setup, "INSTALL_LOG", tmp_path / "install.log")
    monkeypatch.setattr(claude_setup, "MAC_LINUX_COMMAND", "echo downloading; exit 3")
    monkeypatch.setattr(claude_setup, "find_claude", lambda: None)
    claude_setup._install.update(state="idle", error="")
    if claude_setup.platform_id() == "windows":
        return  # the PowerShell installer path is exercised on the Windows build machine
    claude_setup.start_install()
    for _ in range(100):
        if claude_setup.install_state()["state"] != "running":
            break
        time.sleep(0.05)
    state = claude_setup.install_state()
    assert state["state"] == "failed"
    assert "downloading" in state["log"]
