# Agent Operating Contract

This repository is executed by a task-oriented coding harness. This file is a router plus global invariants; it is intentionally much smaller than the full architecture.

## Source-of-truth order

When instructions conflict, use this order:

1. `docs/assignment.md` — evaluator contract.
2. `ARCHITECTURE.md` — authoritative technical design.
3. Generated exact section modules under `docs/architecture/` — context-routing copies of the architecture.
4. Current task brief under `tasks/`.
5. Existing implementation.

Never silently resolve a conflict between levels 1–4. Stop and report it.

## Context policy

For each task:

1. Read the current task brief first.
2. Load only the context aliases named by that task.
3. Read `architecture.invariants` as a routing/checklist aid when the task crosses architectural boundaries.
4. Inspect only implementation files relevant to the task.
5. Expand context only when a concrete dependency is discovered.

Do not read all 3,000+ architecture lines or the whole repository by default.

`ARCHITECTURE.md` is final and authoritative. Files under `docs/architecture/` are generated extracts and must not be edited independently.

## Global architecture invariants

- Runtime: Node.js 22 + TypeScript, Express, PostgreSQL, Prisma; a dedicated `pg` session owns ingestion advisory-lock authority.
- Property resolution is "resolve once, scan by stored identifiers". BBL is parcel identity; ECB scanning is by valid BINs.
- Effective `property_bins` mutation has one transactional owner. A real BIN-set change increments `identifier_version` exactly once and invalidates ECB coverage atomically.
- New ingestion runs persist an immutable Property<->BIN snapshot and immutable batch definitions. Resume never reloads or repartitions the current live watchlist.
- The advisory-lock session is execution authority. Losing it revokes permission to continue state-changing ingestion work.
- Every request/retry/page/batch loop is bounded.
- Raw source versions are persisted before strict domain normalization. Staging is run-scoped and never served.
- Live ECB state changes only through accepted-run publication. Failed/`SOURCE_CHANGED` runs do not promote staging or negatively reconcile live rows.
- Coverage is explicit persisted state and is version-guarded against the snapshotted property `identifier_version`.
- Failure before a committed run property scope is run-level only; do not falsely publish property-level failure.
- Stored-property and ECB query endpoints serve PostgreSQL state; ECB query requests never call Socrata.
- Property ECB keyset pagination must preserve `issue_date DESC NULLS LAST, source_id DESC` with the explicit NULL-aware cursor branches.
- Portfolio ECB output requires both `is_current = true` and current watchlist membership through `property_bins`.
- Clean-machine runtime is Docker Compose with `postgres healthy -> migrate completed -> api/worker` ordering.

Use `architecture.invariants` only as a checklist; load the exact architecture module before implementing any of these rules.

## Working rules

- Work only on the current task; do not implement future tasks opportunistically.
- Do not redesign architecture unless the task explicitly authorizes it.
- Do not modify files outside task `allowed_paths`. If required scope is missing, stop and report the dependency.
- Never modify the assignment, `ARCHITECTURE.md`, generated architecture modules, or sprint blueprint from an ordinary implementation task. If these must change, stop and use the harness plan-change workflow; do not self-authorize a redesign.
- Do not weaken/delete tests or database constraints to make verification pass.
- Do not bypass the single BIN-set mutation boundary or write `property_bins` directly from unrelated code.
- External NYC APIs are mocked in automated tests; real network data belongs to explicit acceptance/scale work.
- Keep changes small, reviewable and deterministic.
- Do not commit; the harness owns commits, merges and integration rollback.

## Test policy

Behavior-changing tasks add/update focused tests when the behavior is testable. The agent may run tests while implementing, but the harness independently re-runs configured verification.

Database behaviors involving uniqueness, transactions, advisory locks, promotion or crash/retry semantics should be validated against real PostgreSQL integration environments where practical, not only mocks.

Real-data seed/BIS/10k tests are final acceptance work and must not be pulled into normal retry loops.

## Definition of done

A coding agent cannot mark a task complete. The harness accepts a task only when:

- task-specific verification passes;
- global verification passes;
- changed files stay within allowed scope;
- protected/review-required path policy is respected;
- independent review passes when configured or forced;
- the containing stage later passes its atomic integration barrier.

When an implementation attempt ends, report concisely:

- `STATUS`: implementation finished / blocked
- `CHANGED_FILES`: files intentionally changed
- `TEST_RESULTS`: commands run and results
- `OPEN_ISSUES`: anything unresolved
