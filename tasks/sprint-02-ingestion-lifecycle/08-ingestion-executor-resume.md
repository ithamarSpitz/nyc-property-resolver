---
id: S2-T8
stage: 4
model_class: hard_worker
timeout_minutes: 70
review: true
allow_protected: false
depends_on:
  - S2-T6
  - S2-T7
allowed_paths:
  - src/services/ecb/ingestion.service.ts
  - tests/integration/ingestion/ingestion-executor.test.ts
context:
  - architecture.ingestion_lifecycle
  - architecture.ingestion_strategy
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/ingestion/ingestion-executor.test.ts
---

# Goal

Compose the S2 primitives into the durable ECB ingestion executor through the publication handoff: acquire dedicated-session authority, create or resume one active run, enforce immutable-watermark/snapshot/batch resume semantics, process only persisted incomplete batches, and fail-stop immediately if execution authority is lost.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md` and the already-integrated S2 services.

# Scope

Implement the application-level ingestion service/orchestrator that:

- acquires the ECB dedicated-session advisory lock before inspecting/creating/resuming run work;
- reports an active executor/run without starting competing work when lock acquisition fails;
- if no active run exists, invokes the new-run initialization service;
- if a `QUEUED` run exists, follows the explicit initialization recovery state rules from S2-T6;
- if a `RUNNING` run exists:
  - fetches the current dataset watermark;
  - compares it to immutable `source_watermark_at_start` before reusing any completed batch;
  - on mismatch, delegates a `SOURCE_CHANGED` terminal decision to `IngestionTerminalPublicationPort` and performs no batch reuse;
  - on match, loads persisted batch definitions only, skips completed batches, and processes pending/retryable batches through S2-T7;
- never reloads/repartitions the current live watchlist during resume;
- stops the run and delegates terminal failure when a batch returns terminal/page-limit/attempt-exhausted failure;
- checks execution authority before state-changing run/batch orchestration operations and passes the lock authority abort signal through to source work;
- if the advisory-lock session emits unexpected loss, stops launching work, allows no mark-complete/publication handoff, and surfaces a non-success executor outcome suitable for worker process non-zero termination;
- after all persisted batches complete, fetches/stores the end watermark and returns one explicit publication handoff outcome:
  - `READY_FOR_PUBLICATION` when the best-effort watermark guard is unchanged;
  - delegated `SOURCE_CHANGED` when it changed;
- does **not** itself implement staging promotion, negative reconciliation, or property coverage publication.

The production-shaped service must depend on the terminal/publication port introduced in S2-T6. S3 will provide the concrete atomic publication implementation; S2 integration tests use a fake publisher to assert decisions without introducing a knowingly non-atomic temporary coverage implementation.

# Out of scope

Do not implement:

- successful staging->live promotion;
- negative reconciliation;
- successful/failed property coverage writes;
- final concrete `COMPLETED` publication;
- scheduler interval or worker/manual CLI entrypoints;
- S4 HTTP query endpoints.

# Invariants

- No process without the dedicated advisory lock executes or resumes ECB ingestion work.
- Resume compares current source watermark to the stored immutable start watermark before completed batch reuse.
- Resume uses only persisted `ingestion_run_property_bins`/`ingestion_batches`; it never reloads the live watchlist.
- Completed batches are skipped after restart; partial/incomplete batches restart through the batch processor from page 1.
- Lock-session loss immediately revokes permission to continue state-changing execution even if Prisma remains healthy.
- S2 ends at an explicit publication decision boundary; it never mutates the accepted live ECB state.

# Acceptance criteria

1. A new execution with no active run acquires authority, initializes the run, processes persisted batches, and returns `READY_FOR_PUBLICATION` when start/end watermarks match.
2. A matching-watermark restart skips completed batches and continues only persisted incomplete/retryable batches.
3. Adding/removing live watchlist BINs after the run snapshot does not alter resumed batch definitions or run requirements.
4. A resume watermark mismatch delegates `SOURCE_CHANGED` before any completed-batch reuse/new batch execution.
5. A terminal/page-limit/attempt-exhausted batch failure stops further batches and delegates the corresponding failure outcome.
6. Advisory-lock loss during execution aborts source work and prevents subsequent mark-complete/publication handoff behavior.
7. Competing executor invocation reports the active owner/run and performs no duplicate execution.
8. All successful S2 execution paths stop at the publication boundary; no live normalized state or coverage is changed in this task.

# Verification

The PostgreSQL-backed integration suite mocks Socrata and the future S3 publication port while exercising actual run/snapshot/batch/lock persistence semantics.
