---
id: S2-T6
stage: 3
model_class: hard_worker
timeout_minutes: 60
review: true
allow_protected: false
depends_on:
  - S2-T2
  - S2-T3
  - S2-T4
  - S2-T5
allowed_paths:
  - src/services/ecb/ingestion-initialization.service.ts
  - src/services/ecb/ingestion-terminal-publication.port.ts
  - tests/integration/ingestion/run-initialization.test.ts
context:
  - architecture.ingestion_lifecycle
  - architecture.storage
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/ingestion/run-initialization.test.ts
---

# Goal

Implement crash-safe new-run initialization: durable `QUEUED` creation, one atomic Property<->BIN snapshot/batch transaction, immutable expected counts, start-watermark acquisition outside that transaction, and one atomic transition to `RUNNING` with the immutable start watermark.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md` and the integrated S1/S2 persistence/source-client primitives.

# Scope

Implement a run-initialization service that, while execution authority is valid:

1. creates a durable `QUEUED` run record immediately after lock ownership has been established;
2. when `initialization_complete=false`, performs one PostgreSQL transaction that:
   - snapshots all current valid `property_bins` relationships into `ingestion_run_property_bins` with each property's current `identifier_version`;
   - derives sorted DISTINCT valid BINs only from that snapshot;
   - deterministically partitions them by configured `ECB_BATCH_SIZE`;
   - persists every immutable `ingestion_batches.batch_definition`;
   - stores `expected_property_bin_count`, `expected_bin_count`, and `expected_batch_count`;
   - sets `initialization_complete=true` only in that same transaction;
3. recovers a `QUEUED + initialization_complete=false` run by rerunning the entire initialization transaction rather than trusting partial rows;
4. recovers `QUEUED + initialized + start watermark NULL` by reusing the persisted snapshot/batches and fetching metadata without rebuilding work;
5. fetches `rowsUpdatedAt` outside the initialization DB transaction;
6. verifies persisted expected counts before moving to `RUNNING`;
7. persists `source_watermark_at_start = X` and `status=RUNNING` atomically in one transaction, with the watermark written once only;
8. on terminal start-watermark fetch failure, delegates to an `IngestionTerminalPublicationPort` rather than implementing S3 property-coverage publication inside this task.

The terminal-publication port is an explicit boundary for S3. Tests may use a deterministic fake/stub publisher; no incomplete concrete coverage publisher belongs in S2.

# Out of scope

Do not implement:

- processing batch pages;
- resume of a `RUNNING` run;
- end-watermark/promotion logic;
- concrete FAILED/SOURCE_CHANGED property coverage publication;
- live normalized-state promotion;
- scheduler/worker wiring.

# Invariants

- New-run Property<->BIN snapshot and batch creation are all-or-nothing in one transaction.
- `RUNNING` is impossible without `initialization_complete=true` and a non-null start watermark.
- No durable state exists with `QUEUED + initialized + non-null start watermark`.
- A start watermark changes only `NULL -> X` once for the run.
- Recovery never rebuilds an already committed initialized snapshot/batch set.
- Snapshot batching uses sorted DISTINCT BINs from the persisted run snapshot, not live watchlist state after initialization.

# Acceptance criteria

1. A successful new-run path persists the exact Property<->BIN snapshot, deterministic batches, expected counts, immutable start watermark, and `RUNNING` state.
2. A forced crash/error inside snapshot or batch creation leaves no partial initialized snapshot/batch set and `initialization_complete` remains false.
3. Retrying an uninitialized QUEUED run rebuilds the entire initialization transaction safely.
4. Retrying an initialized QUEUED run with NULL watermark does not rebuild or repartition the snapshot/batches.
5. A simulated crash after metadata fetch but before watermark persistence leaves `QUEUED + initialized + NULL`, and the next attempt can safely fetch/persist the watermark.
6. Expected-count mismatch prevents transition to RUNNING.
7. Start-watermark fetch terminal failure invokes the publication port with `START_WATERMARK_FETCH_FAILED` and does not invent S3 coverage behavior locally.
8. Changing live `property_bins` after initialization does not change the run's persisted snapshot or batches.

# Verification

All lifecycle assertions in this task run against real PostgreSQL with mocked Socrata metadata and a fake terminal-publication port.
