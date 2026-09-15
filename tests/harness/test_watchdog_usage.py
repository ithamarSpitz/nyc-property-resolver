from __future__ import annotations

import os
from pathlib import Path

from harness.config import HarnessConfig
from harness.runner import CursorAgentRunner
from harness.usage import UsageRecorder


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_watchdog_stalls_silent_agent_and_records_usage(tmp_path: Path):
    os.system(f"git -C {tmp_path} init -q")
    fake = tmp_path / "fake-agent"
    write(fake, """#!/usr/bin/env python3
import time
time.sleep(5)
""")
    os.chmod(fake, 0o755)
    write(tmp_path / "harness.yaml", f"""
execution:
  stall_timeout_minutes: 0.001
  watchdog_poll_seconds: 0.02
worktree: {{}}
cursor:
  command: {fake}
  models: {{worker: cheap}}
verification: {{}}
paths: {{}}
context: {{}}
doctor: {{}}
""")
    config = HarnessConfig.load(tmp_path / "harness.yaml")
    usage = UsageRecorder(tmp_path / ".harness/usage.jsonl")
    runner = CursorAgentRunner(config, tmp_path / ".harness/logs", usage=usage)

    result = runner._invoke(
        task_id="T1",
        phase="implement",
        prompt="x",
        workspace=tmp_path,
        model_class="worker",
        timeout_minutes=1,
        log_name="stall.log",
    )
    assert not result.ok
    assert result.stalled
    events = usage.events()
    assert len(events) == 1
    assert events[0]["stalled"] is True
    assert events[0]["model"] == "cheap"
    assert usage.summary()["cheap"]["stalls"] == 1


def test_watchdog_allows_silent_agent_with_repository_activity(tmp_path: Path):
    os.system(f"git -C {tmp_path} init -q")
    fake = tmp_path / "fake-agent-active"
    write(fake, """#!/bin/sh
workspace="$4"
i=0
while [ "$i" -lt 6 ]; do
  printf '%s' "$i" > "$workspace/progress.txt"
  i=$((i + 1))
  sleep 0.03
done
""")
    os.chmod(fake, 0o755)
    write(tmp_path / "harness.yaml", f"""
execution:
  stall_timeout_minutes: 0.001
  watchdog_poll_seconds: 0.01
worktree: {{}}
cursor:
  command: {fake}
  models: {{worker: cheap}}
verification: {{}}
paths: {{}}
context: {{}}
doctor: {{}}
""")
    config = HarnessConfig.load(tmp_path / "harness.yaml")
    runner = CursorAgentRunner(config, tmp_path / ".harness/logs")
    result = runner._invoke(
        task_id="T2",
        phase="implement",
        prompt="x",
        workspace=tmp_path,
        model_class="worker",
        timeout_minutes=1,
        log_name="active.log",
    )
    assert result.ok
    assert not result.stalled
    assert (tmp_path / "progress.txt").read_text(encoding="utf-8") == "5"
