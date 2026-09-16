from __future__ import annotations

import json
import threading
from collections import defaultdict
from pathlib import Path
from typing import Any

from .logging_utils import utc_now


class UsageRecorder:
    """Append-only local accounting for agent calls.

    Cursor's text CLI does not guarantee token/cost metadata, so this records
    facts the harness can prove: calls, requested model, duration, outcome and
    output size. If machine-readable usage is exposed later, it can be added
    without changing task definitions.
    """

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def record(self, event: dict[str, Any]) -> None:
        payload = {"recorded_at": utc_now(), **event}
        with self._lock:
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(payload, sort_keys=True) + "\n")

    def events(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        result: list[dict[str, Any]] = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                result.append(json.loads(line))
        return result

    def summary(self) -> dict[str, dict[str, float | int]]:
        groups: dict[str, dict[str, float | int]] = defaultdict(
            lambda: {"calls": 0, "seconds": 0.0, "failures": 0, "stalls": 0, "timeouts": 0, "quota_pauses": 0, "capacity_pauses": 0}
        )
        for event in self.events():
            key = str(event.get("model") or event.get("model_class") or "default")
            row = groups[key]
            row["calls"] = int(row["calls"]) + 1
            row["seconds"] = float(row["seconds"]) + float(event.get("duration_seconds", 0.0))
            if not event.get("ok", False):
                row["failures"] = int(row["failures"]) + 1
            if event.get("stalled", False):
                row["stalls"] = int(row["stalls"]) + 1
            if event.get("timed_out", False):
                row["timeouts"] = int(row["timeouts"]) + 1
            if event.get("quota_exhausted", False):
                row["quota_pauses"] = int(row["quota_pauses"]) + 1
            if event.get("capacity_exhausted", False):
                row["capacity_pauses"] = int(row["capacity_pauses"]) + 1
        return dict(groups)
