from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_project_blueprint_is_valid() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check-project-blueprint.py"],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "6 sprints" in result.stdout


def test_generated_architecture_contexts_are_current() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/generate-architecture-contexts.py", "--check"],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "10 files" in result.stdout


def test_s0_through_s5_project_sprints_are_executable_and_match_blueprint_stages() -> None:
    import yaml

    roadmap = yaml.safe_load((ROOT / "tasks" / "roadmap.yaml").read_text(encoding="utf-8"))
    project_sprints = {k: v for k, v in (roadmap.get("sprints") or {}).items() if k != "demo"}
    assert set(project_sprints) == {"S0-foundation", "S1-property-resolution", "S2-ingestion-lifecycle", "S3-ingestion-publication", "S4-api-operations", "S5-acceptance-submission"}

    s0 = project_sprints["S0-foundation"]
    s0_tasks = s0["tasks"]
    assert set(s0_tasks) == {"S0-T1", "S0-T2", "S0-T3", "S0-T4", "S0-T5"}
    assert s0_tasks["S0-T1"]["stage"] == 1
    assert {s0_tasks[t]["stage"] for t in ("S0-T2", "S0-T3", "S0-T4")} == {2}
    assert s0_tasks["S0-T5"]["stage"] == 3
    assert set(s0_tasks["S0-T5"]["depends_on"]) == {"S0-T2", "S0-T3", "S0-T4"}

    s1 = project_sprints["S1-property-resolution"]
    s1_tasks = s1["tasks"]
    assert set(s1_tasks) == {f"S1-T{i}" for i in range(1, 11)}
    assert s1_tasks["S1-T1"]["stage"] == 1
    assert {s1_tasks[f"S1-T{i}"]["stage"] for i in range(2, 7)} == {2}
    assert set(s1_tasks["S1-T7"]["depends_on"]) == {f"S1-T{i}" for i in range(2, 7)}
    assert s1_tasks["S1-T7"]["stage"] == 3
    assert {s1_tasks["S1-T8"]["stage"], s1_tasks["S1-T9"]["stage"]} == {4}
    assert set(s1_tasks["S1-T10"]["depends_on"]) == {"S1-T8", "S1-T9"}
    assert s1_tasks["S1-T10"]["stage"] == 5

    s2 = project_sprints["S2-ingestion-lifecycle"]
    s2_tasks = s2["tasks"]
    assert set(s2_tasks) == {f"S2-T{i}" for i in range(1, 10)}
    assert s2_tasks["S2-T1"]["stage"] == 1
    assert {s2_tasks[f"S2-T{i}"]["stage"] for i in range(2, 6)} == {2}
    assert {s2_tasks["S2-T6"]["stage"], s2_tasks["S2-T7"]["stage"]} == {3}
    assert set(s2_tasks["S2-T6"]["depends_on"]) == {f"S2-T{i}" for i in range(2, 6)}
    assert set(s2_tasks["S2-T7"]["depends_on"]) == {f"S2-T{i}" for i in range(2, 6)}
    assert s2_tasks["S2-T8"]["stage"] == 4
    assert set(s2_tasks["S2-T8"]["depends_on"]) == {"S2-T6", "S2-T7"}
    assert s2_tasks["S2-T9"]["stage"] == 5
    assert s2_tasks["S2-T9"]["depends_on"] == ["S2-T8"]
    s3 = project_sprints["S3-ingestion-publication"]
    s3_tasks = s3["tasks"]
    assert set(s3_tasks) == {f"S3-T{i}" for i in range(1, 6)}
    assert [s3_tasks[f"S3-T{i}"]["stage"] for i in range(1, 6)] == [1, 2, 3, 4, 5]
    assert s3_tasks["S3-T1"]["depends_on"] == []
    assert s3_tasks["S3-T2"]["depends_on"] == ["S3-T1"]
    assert s3_tasks["S3-T3"]["depends_on"] == ["S3-T2"]
    assert s3_tasks["S3-T4"]["depends_on"] == ["S3-T3"]
    assert s3_tasks["S3-T5"]["depends_on"] == ["S3-T4"]

    s4 = project_sprints["S4-api-operations"]
    s4_tasks = s4["tasks"]
    assert set(s4_tasks) == {f"S4-T{i}" for i in range(1, 9)}
    assert {s4_tasks[f"S4-T{i}"]["stage"] for i in range(1, 5)} == {1}
    assert s4_tasks["S4-T5"]["stage"] == 2
    assert set(s4_tasks["S4-T5"]["depends_on"]) == {"S4-T1", "S4-T4"}
    assert s4_tasks["S4-T6"]["stage"] == 2
    assert set(s4_tasks["S4-T6"]["depends_on"]) == {"S4-T2", "S4-T4"}
    assert s4_tasks["S4-T7"]["stage"] == 3
    assert set(s4_tasks["S4-T7"]["depends_on"]) == {"S4-T3", "S4-T5", "S4-T6"}
    assert s4_tasks["S4-T8"]["stage"] == 4
    assert s4_tasks["S4-T8"]["depends_on"] == ["S4-T7"]
    s5 = project_sprints["S5-acceptance-submission"]
    s5_tasks = s5["tasks"]
    assert set(s5_tasks) == {f"S5-T{i}" for i in range(1, 6)}
    assert [s5_tasks[f"S5-T{i}"]["stage"] for i in range(1, 6)] == [1, 2, 3, 4, 5]
    assert s5_tasks["S5-T1"]["depends_on"] == []
    assert s5_tasks["S5-T2"]["depends_on"] == ["S5-T1"]
    assert s5_tasks["S5-T3"]["depends_on"] == ["S5-T2"]
    assert s5_tasks["S5-T4"]["depends_on"] == ["S5-T3"]
    assert s5_tasks["S5-T5"]["depends_on"] == ["S5-T4"]

