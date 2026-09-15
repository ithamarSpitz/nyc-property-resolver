#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
BLUEPRINT = ROOT / "plans" / "sprints.yaml"
HARNESS_CONFIG = ROOT / "harness.yaml"


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path.relative_to(ROOT)} must contain a YAML object")
    return data


def validate() -> list[str]:
    errors: list[str] = []
    if not BLUEPRINT.exists():
        return ["plans/sprints.yaml is missing"]
    if not HARNESS_CONFIG.exists():
        return ["harness.yaml is missing"]

    plan = load_yaml(BLUEPRINT)
    harness = load_yaml(HARNESS_CONFIG)
    aliases = (((harness.get("context") or {}).get("aliases")) or {})

    required_plan_files = [
        "plans/task-generation-policy.yaml",
        "plans/verification-matrix.yaml",
        "plans/environment-contract.yaml",
        "plans/path-policy.yaml",
        "plans/model-routing.yaml",
        "plans/risk-register.yaml",
        "plans/change-control.yaml",
        "plans/quota-policy.yaml",
    ]
    for rel in required_plan_files:
        if not (ROOT / rel).exists():
            errors.append(f"required planning artifact is missing: {rel}")

    source = plan.get("source_of_truth") or {}
    for name, rel in source.items():
        path = ROOT / str(rel)
        if not path.exists():
            errors.append(f"source_of_truth.{name} does not exist: {rel}")

    sprints = plan.get("sprints") or {}
    if not isinstance(sprints, dict) or not sprints:
        errors.append("plans/sprints.yaml must define at least one sprint")
        return errors

    sprint_ids = set(sprints)
    graph: dict[str, list[str]] = {}
    for sprint_id, raw in sprints.items():
        if not isinstance(raw, dict):
            errors.append(f"{sprint_id}: sprint definition must be an object")
            continue
        deps = list(raw.get("depends_on") or [])
        graph[sprint_id] = deps
        for dep in deps:
            if dep not in sprint_ids:
                errors.append(f"{sprint_id}: unknown sprint dependency {dep}")

        for alias in raw.get("context") or []:
            if alias not in aliases:
                errors.append(f"{sprint_id}: unknown context alias {alias}")
            else:
                context_path = ROOT / str(aliases[alias])
                if not context_path.exists():
                    errors.append(f"{sprint_id}: context alias {alias} points to missing file {aliases[alias]}")

        stages = raw.get("stages") or []
        if not isinstance(stages, list) or not stages:
            errors.append(f"{sprint_id}: must define at least one stage")
            continue
        stage_ids: list[int] = []
        for stage in stages:
            if not isinstance(stage, dict):
                errors.append(f"{sprint_id}: stage definition must be an object")
                continue
            stage_id = stage.get("id")
            if not isinstance(stage_id, int) or stage_id < 1:
                errors.append(f"{sprint_id}: stage id must be a positive integer")
                continue
            if stage_id in stage_ids:
                errors.append(f"{sprint_id}: duplicate stage id {stage_id}")
            stage_ids.append(stage_id)
            for dep in stage.get("depends_on") or []:
                if dep not in stage_ids:
                    errors.append(
                        f"{sprint_id} stage {stage_id}: dependency {dep} must reference an earlier declared stage"
                    )
        if stage_ids != sorted(stage_ids):
            errors.append(f"{sprint_id}: stages must be declared in ascending order")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> None:
        if node in visited:
            return
        if node in visiting:
            errors.append(f"sprint dependency cycle detected at {node}")
            return
        visiting.add(node)
        for dep in graph.get(node, []):
            if dep in graph:
                visit(dep)
        visiting.remove(node)
        visited.add(node)

    for sprint_id in graph:
        visit(sprint_id)

    risk_path = ROOT / "plans" / "risk-register.yaml"
    if risk_path.exists():
        risks = load_yaml(risk_path).get("risks") or []
        for row in risks:
            if not isinstance(row, dict):
                errors.append("risk-register entries must be objects")
                continue
            for alias in row.get("context") or []:
                if alias not in aliases:
                    errors.append(f"risk {row.get('id', '?')}: unknown context alias {alias}")

    if plan.get("runnable") is not False:
        errors.append("blueprint must remain non-runnable; executable task graphs belong in tasks/roadmap.yaml")

    return errors


def main() -> int:
    errors = validate()
    if errors:
        print("Project blueprint validation FAILED:")
        for error in errors:
            print(f"  - {error}")
        return 1
    plan = load_yaml(BLUEPRINT)
    sprints = plan["sprints"]
    stage_count = sum(len((row or {}).get("stages") or []) for row in sprints.values())
    roadmap_path = ROOT / "tasks" / "roadmap.yaml"
    runnable = []
    if roadmap_path.exists():
        roadmap = load_yaml(roadmap_path)
        runnable = list((roadmap.get("sprints") or {}).keys())
    project_runnable = [s for s in runnable if s != "demo"]
    runnable_text = ", ".join(project_runnable) if project_runnable else "none"
    print(
        f"Project blueprint OK: {len(sprints)} sprints, {stage_count} stages; "
        f"executable project sprints: {runnable_text}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
