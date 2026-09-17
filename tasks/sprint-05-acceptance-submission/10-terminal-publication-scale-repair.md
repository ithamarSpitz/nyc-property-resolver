---
id: S5-T10
stage: 5
model_class: hard_worker
timeout_minutes: 120
review: true
allow_protected: false
depends_on:
  - S5-T8
allowed_paths:
  - src/services/ecb/terminal-publication.service.ts
  - src/services/ecb/ingestion.service.ts
  - src/services/ecb/ingestion-runner.service.ts
  - src/config/defaults.ts
  - src/config/env.ts
  - .env.example
  - docker-compose.yml
  - tests/integration/ingestion/terminal-publication.scale.test.ts
  - tests/integration/ingestion/terminal-failure-recovery.test.ts
context:
  - architecture.ingestion_lifecycle
  - architecture.ingestion_strategy
  - architecture.storage
  - architecture.operations
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/ingestion/terminal-publication.scale.test.ts tests/integration/ingestion/terminal-failure-recovery.test.ts
---

# Goal

Repair atomic terminal-failure publication so an exhausted ECB run can
terminalize reliably at the required property scale without weakening snapshot,
coverage, or transaction guarantees.

# Proven failure

S5-T3 produced a committed run snapshot for 10,000 properties / 10,815 valid
BINs. Batch 1 exhausted all 3 logical attempts and became `FAILED`, but terminal
publication raised `PrismaClientKnownRequestError`; the ingestion run remained
`RUNNING`.

The preserved PostgreSQL state contains 11 immutable batches. The first is
`FAILED` with `attempt_count=3`; the remaining batches are pending.

A read-only reproduction against the preserved database executed the existing
failed-coverage SQL shape inside `BEGIN ... ROLLBACK`:

- run status update: about 15 ms;
- property lock: about 50 ms;
- snapshot-version grouping: about 14 ms;
- failed-coverage upsert: about 4,108 ms for 9,755 eligible properties.

The current `TerminalPublicationService` uses an interactive Prisma
`$transaction(async ...)` without a task-specific timeout override. The measured
coverage statement therefore consumes most of the default transaction budget
before ORM round trips, run locking, final reads and commit are included.

The original Prisma error code was not preserved. Do not make recovering that
missing code a prerequisite to fixing the proven scale defect.

# Scope

Keep run terminalization and failed-attempt coverage publication in one atomic
database transaction, while making that transaction scale-safe.

The repair must:

1. replace per-property/correlated failed-batch attribution with a set-based
   shape that computes failed BIN/batch attribution once and joins it to the
   immutable run snapshot;
2. preserve identifier-version guards and the existing
   `RUN_NOT_PROMOTED`/concrete-failure attribution semantics;
3. preserve all `last_success_*` fields and leave live ECB data and negative
   reconciliation untouched on failure;
4. use an explicit finite interactive-transaction timeout with enough measured
   headroom for the 10k acceptance and the documented 20k strategy; do not use
   an unbounded transaction;
5. prove on real PostgreSQL that a roughly 10,000-property / 10,815-BIN failure
   publication commits atomically rather than timing out;
6. prove recovery from a persisted `RUNNING` run whose batch is already
   terminally exhausted: the next bounded ingestion execution must publish the
   terminal failure instead of leaving the run indefinitely `RUNNING`.

If a configurable timeout is introduced, wire it through the existing config
contract and `.env.example`; do not add a hidden environment read inside the
service.

# Out of scope

Do not:

- split run status and failed coverage into separate transactions;
- drop property locks, snapshot-version checks, execution-authority checks, or
  atomicity hooks merely to improve timing;
- change batch size, Socrata page size, concurrency or retry limits;
- change successful promotion or negative reconciliation semantics;
- change S5-T3's benchmark/evidence contract;
- add a test-only fast path or fixture-specific exception.

# Acceptance criteria

1. Batch-attempt exhaustion cannot leave an otherwise publishable run
   indefinitely `RUNNING`.
2. Run transition and eligible failed coverage still commit atomically.
3. A forced error after the run update or during coverage publication rolls the
   whole transaction back.
4. Version-mismatched properties are not mutated.
5. `last_success_run_id`, `last_success_at`, and `source_watermark_at` remain
   unchanged on failure.
6. Directly affected properties retain concrete failure attribution; other
   version-matching snapshot properties receive `RUN_NOT_PROMOTED`.
7. A real-PostgreSQL scale test exercises approximately the S5-T3 snapshot size
   and completes within the explicit finite transaction budget.
8. Recovery from `RUNNING + exhausted batch` reaches terminal `FAILED` without
   rebuilding the immutable run snapshot.

# Verification note

No live NYC traffic is required for this repair. The deterministic PostgreSQL
tests are authoritative here. After S5-T9 and S5-T10 are integrated, S5-T3 is
the one fresh live 10,000-property proof.
