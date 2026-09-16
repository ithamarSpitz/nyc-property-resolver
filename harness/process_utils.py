from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Sequence


def split_command(command: str) -> list[str]:
    """Split a configured command line on the current platform.

    Configured commands are normally simple (for example ``agent`` or
    ``docker compose``). On Windows, ``shlex`` in POSIX mode corrupts
    backslashes, so use non-POSIX parsing and strip only wrapping quotes.
    """
    if not command.strip():
        return []
    if os.name != "nt":
        return shlex.split(command)
    parts = shlex.split(command, posix=False)
    cleaned: list[str] = []
    for part in parts:
        if len(part) >= 2 and part[0] == part[-1] and part[0] in {'"', "'"}:
            part = part[1:-1]
        cleaned.append(part)
    return cleaned


def locate_executable(command: str) -> str | None:
    """Resolve an executable token, also accepting an explicit script path."""
    candidate = Path(command)
    if candidate.is_file():
        return str(candidate.resolve())
    return shutil.which(command)


def prepare_external_argv(argv: Sequence[str], *, windows: bool | None = None) -> list[str]:
    """Return argv that Python can execute directly on this platform.

    Windows ``subprocess`` cannot execute ``.cmd``/``.bat`` shims directly in
    every context. Cursor's ``agent`` command can be installed as such a shim,
    so route it through ``cmd.exe``. Python scripts are routed through the
    current interpreter, which also makes harness test doubles portable.
    """
    if not argv:
        raise ValueError("external command is empty")

    is_windows = os.name == "nt" if windows is None else windows
    resolved = locate_executable(str(argv[0])) or str(argv[0])
    rest = [str(part) for part in argv[1:]]
    suffix = Path(resolved).suffix.lower()

    if suffix == ".py":
        return [sys.executable, resolved, *rest]

    if is_windows and suffix in {".cmd", ".bat"}:
        comspec = os.environ.get("COMSPEC") or "cmd.exe"
        command_line = subprocess.list2cmdline([resolved, *rest])
        return [comspec, "/d", "/s", "/c", command_line]

    if is_windows and suffix == ".ps1":
        powershell = shutil.which("powershell.exe") or shutil.which("powershell") or "powershell.exe"
        return [
            powershell,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            resolved,
            *rest,
        ]

    return [resolved, *rest]
