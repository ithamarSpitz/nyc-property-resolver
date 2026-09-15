from harness.verifier import _matches


def test_scope_glob_prefix():
    assert _matches("src/services/a.ts", "src/**")
    assert _matches("src/services/a.ts", "src/services/**")
    assert not _matches("tests/a.ts", "src/**")


def test_exact_path():
    assert _matches("package.json", "package.json")
    assert not _matches("package-lock.json", "package.json")

from harness.models import TaskSpec
from harness.scheduler import Scheduler
from pathlib import Path


def _task(task_id: str, patterns: list[str]) -> TaskSpec:
    return TaskSpec(id=task_id, file=Path("x"), sprint="s", stage=1, allowed_paths=patterns)


def test_parallel_scope_conflict_detection():
    assert Scheduler._tasks_may_conflict(_task("A", ["src/services/**"]), _task("B", ["src/services/x.ts"]))
    assert not Scheduler._tasks_may_conflict(_task("A", ["src/a/**"]), _task("B", ["src/b/**"]))
    assert Scheduler._tasks_may_conflict(_task("A", []), _task("B", ["src/b/**"]))


def test_review_required_paths_force_review_match(tmp_path):
    from harness.config import HarnessConfig
    from harness.git_worktree import WorktreeManager
    from harness.verifier import Verifier

    (tmp_path / "harness.yaml").write_text("""
execution: {}
worktree: {}
cursor: {models: {}}
verification: {}
paths:
  protected: []
  review_required:
    - ARCHITECTURE.md
    - prisma/**
""", encoding="utf-8")
    config = HarnessConfig.load(tmp_path / "harness.yaml")
    verifier = Verifier(config, tmp_path / "logs", WorktreeManager(tmp_path, tmp_path / ".harness"))
    assert verifier.requires_review(["ARCHITECTURE.md"])
    assert verifier.requires_review(["prisma/schema.prisma"])
    assert not verifier.requires_review(["src/a.ts"])
