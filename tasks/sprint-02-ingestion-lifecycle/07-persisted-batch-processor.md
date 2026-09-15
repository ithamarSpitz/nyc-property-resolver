---
id: S2-T7
stage: 3
model_class: hard_worker
timeout_minutes: 65
review: true
allow_protected: false
depends_on:
  - S2-T2
  - S2-T3
  - S2-T4
  - S2-T5
allowed_paths:
  - src/services/ecb/batch-processor.service.ts
  - tests/integration/ingestion/batch-processor.test.ts
context:
  - architecture.ingestion_strategy
  - architecture.ingestion_lifecycle
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/ingestion/batch-processor.test.ts
---

# Goal

Implement one replay-safe persisted-batch execution primitive: logical attempt accounting, ordered bounded Socrata page traversal, raw-before-strict-normalization/staging, page-limit failure, and deterministic restart from page 1 for every new logical attempt.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md` and the integrated S2 client/request/raw-staging/lock-authority primitives.

# Scope

Implement a batch processor that accepts an already-persisted immutable `ingestion_batches.batch_definition` and valid execution authority. For one logical batch attempt it must:

- verify authority before launching state-changing work and stop promptly when the authority abort signal fires;
- increment/persist the logical batch `attempt_count` exactly once per logical execution;
- start Socrata paging at offset/page 0 for every logical attempt, including retries after a partial/crashed attempt;
- use the Socrata client through the bounded request executor for each ordered page;
- persist raw versions then strict-normalize/write run-scoped staging through S2-T4;
- persist page/row progress needed for observability without treating offset as a durable resume cursor;
- stop when a page is terminal/short according to the source contract;
- enforce `SOCRATA_MAX_PAGES_PER_BATCH` and return/record `FAILED_PAGE_LIMIT` when additional source data may remain at the ceiling;
- mark the logical batch complete only after all source pages for its immutable BIN set succeeded;
- make a batch terminal for the current run after `MAX_BATCH_ATTEMPTS_PER_RUN` is exhausted;
- return explicit outcomes to the higher-level executor instead of publishing S3 coverage/live state.

Tests must prove replay/idempotency against real PostgreSQL using mocked Socrata page sequences.

# Out of scope

Do not implement:

- selection/creation of ingestion runs;
- run Property<->BIN snapshot/batch construction;
- reloading/repartitioning the watchlist;
- start-watermark resume comparison;
- end-watermark promotion decision;
- live `ecb_violations` publication;
- coverage publication;
- scheduler/manual CLI.

# Invariants

- A persisted batch definition never changes during its run.
- Every new logical attempt restarts source pagination from page 1/offset 0.
- `$offset` is not a crash-resume cursor.
- HTTP request retries do not increment logical batch `attempt_count`.
- Raw/staging replay makes restarting a partial batch safe.
- A page-limit ceiling with possible remaining rows is never marked complete.
- Exhausted logical attempts are terminal for that run; automatic resume does not loop forever.

# Acceptance criteria

1. A multi-page mocked batch writes all raw/staging candidates and marks the persisted batch complete with correct page/row metrics.
2. A simulated crash/failure after earlier pages leaves replay-safe raw/staging data; the next logical attempt starts again from the first page and creates no logical duplicates.
3. Request-level retries do not consume extra logical batch attempts.
4. `SOCRATA_MAX_PAGES_PER_BATCH` exhaustion with possible more rows yields `FAILED_PAGE_LIMIT` and never `COMPLETED`.
5. Repeated logical failures stop at `MAX_BATCH_ATTEMPTS_PER_RUN` and return a terminal batch-failure outcome.
6. Authority loss during paging prevents new pages/state-changing completion writes.
7. The processor never queries live `property_bins` or recomputes its batch membership.

# Verification

The integration suite uses real PostgreSQL and deterministic mocked page/retry/failure sequences; no live NYC request is required.
