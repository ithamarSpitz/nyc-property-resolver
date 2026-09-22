from __future__ import annotations

import sys

from harness.process_utils import prepare_external_argv, split_command


def test_windows_cmd_shim_is_routed_through_comspec(monkeypatch):
    monkeypatch.setenv("COMSPEC", r"C:\\Windows\\System32\\cmd.exe")
    argv = prepare_external_argv([r"C:\\Tools\\agent.cmd", "models"], windows=True)
    assert argv[:4] == [r"C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c"]
    assert "agent.cmd" in argv[4]
    assert "models" in argv[4]


def test_python_script_uses_current_interpreter_cross_platform(tmp_path):
    script = tmp_path / "fake-agent.py"
    script.write_text("print('ok')\n", encoding="utf-8")
    argv = prepare_external_argv([str(script), "--version"], windows=True)
    assert argv == [sys.executable, str(script.resolve()), "--version"]


def test_simple_configured_command_splits_portably():
    assert split_command("docker compose") == ["docker", "compose"]


def test_windows_batch_cursor_uses_stdin_prompt_transport():
    from harness.process_utils import cursor_prompt_via_stdin

    assert cursor_prompt_via_stdin(r"C:\\Tools\\agent.cmd", windows=True)
    assert cursor_prompt_via_stdin(r"C:\\Tools\\cursor-agent.BAT", windows=True)
    assert not cursor_prompt_via_stdin(r"C:\\Tools\\agent.exe", windows=True)
    assert not cursor_prompt_via_stdin("agent", windows=False)
