---
id: S5-T11
stage: 6
model_class: hard_worker
timeout_minutes: 150
review: true
allow_protected: false
depends_on:
  - S5-T9
  - S5-T10
allowed_paths:
  - src/services/ecb/accepted-publication.service.ts
  - src/services/ecb/live-state.repository.ts
  - src/services/ecb/successful-coverage.service.ts
  - src/services/ecb/ingestion.service.ts
  - src/services/ecb/ingestion-runner.service.ts
  - src/config/defaults.ts
  - src/config/env.ts
  - .env.example
  - docker-compose.yml
  - src/cli/ingest-ecb.ts
  - tests/unit/cli/ingest-ecb.test.ts
  - tests/integration/ingestion/accepted-publication.scale.test.ts
  - tests/integration/ingestion/accepted-publication-recovery.test.ts
  - tests/integration/ingestion/ingestion-publication.behavior.test.ts
context:
  - architecture.ingestion_lifecycle
  - architecture.ingestion_strategy
  - architecture.storage
  - architecture.operations
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/cli/ingest-ecb.test.ts
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps -e INGESTION_PUBLICATION_INTEGRATION=1 worker npm test -- --runInBand tests/integration/ingestion/accepted-publication.scale.test.ts tests/integration/ingestion/accepted-publication-recovery.test.ts tests/integration/ingestion/ingestion-publication.behavior.test.ts tests/integration/ingestion/terminal-publication.scale.test.ts tests/integration/ingestion/terminal-failure-recovery.test.ts
---

# Goal

Repair accepted-run publication at the required property scale without weakening
the atomic publication contract, then make an already-extracted accepted run
recoverable after a publication-only failure.

# Proven failure

The fresh S5-T3 run registered 10,000 properties and 10,815 valid BINs. All 11
ECB batches completed, the start/end source watermarks matched, and 81,507 rows
were persisted to staging. Accepted publication then raised
`PrismaClientKnownRequestError`; the run remained `RUNNING`, with zero promoted
rows and zero successful-coverage rows.

This failure is after extraction/batch completion. It is distinct from the
terminal-failure publication defect repaired by S5-T10.

The accepted path currently performs validation, live-state promotion, negative
reconciliation, successful coverage publication, and the `COMPLETED` transition
inside one interactive Prisma transaction without its own explicit finite
transaction timeout. The terminal-failure path already has a separate finite
timeout.

The exact Prisma error code from the failed live run was not preserved, so the
corrective implementation must prove the cause and required headroom
deterministically rather than assuming that a timeout increase alone is enough.

# Scope

Keep accepted publication as one atomic database transaction and make it
scale-safe.

The repair must:

1. add a distinct, explicit, positive, finite accepted-publication transaction
   timeout and wire it through the normal configuration contract and production
   composition; choose the default from measured PostgreSQL behavior, with
   headroom for the required 10k run and documented 20k strategy;
2. exercise a real-PostgreSQL fixture approximating the observed acceptance
   shape: 10,000 properties, 10,815 BINs, and 81,507 staging rows;
3. measure enough of the accepted-publication phases to determine whether the
   finite timeout alone is sufficient; if it is not, optimize only the
   inefficient set-based validation/promotion/coverage SQL necessary to fit the
   finite bound;
4. preserve the single transaction containing live-state promotion, negative
   reconciliation, successful coverage publication, and the final `COMPLETED`
   transition;
5. preserve property locking, identifier-version guards, execution-authority
   checks, newer-run guards, rollback guarantees, and replay/idempotency
   semantics;
6. recover a persisted initialized `RUNNING` run whose expected batches are all
   `COMPLETED` and whose persisted start/end watermarks match: a later bounded
   execution must publish that already-extracted run instead of rebuilding its
   immutable snapshot or repeating completed batch/source work;
7. keep terminal-failure publication behavior from S5-T10 intact;
8. preserve actionable structured diagnostics for publication failures. When the
   thrown error exposes a Prisma error code/message, the manual ingestion log
   must retain `errorType`, the Prisma error code, and the full error message,
   without logging source payloads or secrets.

# Out of scope

Do not:

- split accepted publication into separately committed transactions;
- weaken or remove property locks, source-watermark checks,
  identifier-version checks, authority checks, negative reconciliation, or
  atomic rollback;
- change ECB query shape, pagination, batch size, concurrency, retries, or
  normalization;
- change S5-T9's sentinel-date behavior;
- change terminal-failure semantics merely to share implementation;
- modify the S5-T3 scale runner, seed, or evidence;
- add a live-network test or fixture-specific production exception;
- treat the prior failed S5-T3 run as final acceptance evidence.

# Acceptance criteria

1. A real-PostgreSQL accepted-publication scale test uses approximately
   10,000 properties / 10,815 BINs / 81,507 staging rows and commits within the
   configured finite accepted-publication transaction budget.
2. The accepted run reaches `COMPLETED`; staging candidates are promoted,
   negative reconciliation is applied, and eligible successful coverage is
   published atomically.
3. Forced failures after live-state mutation and after coverage mutation roll
   the whole accepted publication back.
4. Identifier-version mismatches remain excluded from successful coverage and
   preserve the existing mismatch semantics.
5. Authority loss cannot commit a hybrid accepted state.
6. Replaying an already completed publication remains an explicit no-op.
7. `RUNNING + initialized snapshot + all expected batches COMPLETED + matching
   persisted watermarks` can recover to successful publication without
   rebuilding the snapshot/batches or repeating completed source/batch work.
8. The new timeout is configurable through defaults/env/Compose/runner wiring,
   validated as a positive finite integer, and is separate from the terminal
   publication timeout.
9. Existing ingestion-publication behavior tests pass, including positive
   publication, rollback, negative reconciliation, identifier-version and
   authority-loss cases.
10. S5-T10 terminal-publication scale and recovery tests continue to pass.
11. Manual-ingestion failure diagnostics preserve `errorType` plus Prisma
    `errorCode` and `errorMessage` when available; a focused CLI unit test proves
    this without exposing source payloads or secrets.

# Verification note

No live NYC traffic is required for this corrective task. Deterministic
PostgreSQL tests are authoritative here.

Do not run S5-T3 from this task. After S5-T11 is reviewed and integrated, S5-T3
remains the one fresh live 10,000-property acceptance proof.
