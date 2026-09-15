# Project Execution Planning Index

These files prepare the final architecture for task-oriented agent execution without defining any concrete coding task yet.

- `SPRINTS.md` — human-readable sprint/stage blueprint.
- `DEPENDENCY_GRAPH.md` — high-level dependency/parallelism rules.
- `CONTEXT_ROUTING.md` — source hierarchy and architecture aliases.
- `ENVIRONMENT_PLAN.md` — application vs harness configuration and Docker isolation.
- `VERIFICATION_PLAN.md` — task/stage/sprint/final test layers.
- `FAILURE_RECOVERY.md` — retry/block/barrier, plan-revision and quota-wait recovery behavior.
- `CHANGE_CONTROL.md` — post-start plan/architecture repair workflow.
- `QUOTA_POLICY.md` — included-usage exhaustion, wait/keep-awake and safe resume behavior.
- `ACCEPTANCE_PLAN.md` — real-data, BIS, idempotency and 10k evidence sequence.

Machine-readable planning artifacts live under `plans/`.

No file in this directory is a replacement for the assignment or `ARCHITECTURE.md`.
