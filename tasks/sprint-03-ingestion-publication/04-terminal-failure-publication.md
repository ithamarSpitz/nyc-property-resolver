---
id: S3-T4
stage: 4
model_class: hard_worker
timeout_minutes: 70
review: true
allow_protected: false
depends_on:
  - S3-T3
allowed_paths:
  - src/services/ecb/terminal-publication.service.ts
  - tests/integration/ingestion/terminal-failure-publication.test.ts
context:
  - architecture.resolver
  - architecture.ingestion_lifecycle
  - architecture.storage
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/ingestion/terminal-failure-publication.test.ts
---

# Goal

Implement the concrete atomic `IngestionTerminalPublicationPort` for `FAILED` and `SOURCE_CHANGED`: terminalize the run and publish only eligible property-attempt failures in the same PostgreSQL transaction, while preserving previous successful coverage/live state and respecting committed-scope and identifier-version guards.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`, the S2 `ingestion-terminal-publication.port.ts`, run snapshot/batch persistence, and S1 identifier-version semantics.

# Scope

Implement `terminal-publication.service.ts` as the concrete S3 implementation of the S2 terminal-publication boundary. For a terminal failure outcome it must:

- accept only architecture-supported terminal statuses/reasons (`FAILED` / `SOURCE_CHANGED` and explicit failure stage/error data);
- require valid execution authority for ordinary terminal publication; lock-session-loss fail-stop itself must not be converted into a stale publisher continuing after authority revocation;
- execute one PostgreSQL transaction that:
  1. updates `ingestion_runs` terminal status, finish time, failure stage/error and applicable terminal metrics;
  2. determines whether a committed run Property<->BIN scope exists;
  3. if no committed scope exists, performs **no** property coverage mutation;
  4. if committed scope exists, derives eligible properties only from `ingestion_run_property_bins` for that run;
  5. applies the same current-vs-snapshot `identifier_version` guard used by success publication;
  6. for eligible matching-version properties, sets attempt coverage to `FAILED`, current run attempt metadata and the appropriate error/status reason while preserving all `last_success_*` and accepted `source_watermark_at` fields;
- attribute failure reasons from the run snapshot/batches:
  - `SOURCE_CHANGED` for source-watermark rejection;
  - the concrete batch/source/normalization error when one of the property's required snapshot BINs belongs to a failed batch;
  - `RUN_NOT_PROMOTED` for a property whose own required BIN work succeeded but the run as a whole was rejected/failed for another reason;
- never promote staging, never perform negative reconciliation, and never modify the accepted live `ecb_violations` state.

# Out of scope

Do not implement:

- successful accepted publication;
- scheduler/manual CLI;
- retrying failed batches;
- API response shaping;
- changing property identifiers or coverage initialization rules.

# Invariants

- Run terminal status and eligible failed-attempt coverage commit atomically.
- Failure before committed run property scope mutates run/dataset operational state only, not property coverage.
- Failure publication never overwrites coverage for a newer property identifier version.
- `last_success_run_id`, `last_success_at`, and accepted `source_watermark_at` survive a later failed/source-changed attempt.
- FAILED/SOURCE_CHANGED never promotes staging or reconciles current live rows.

# Acceptance criteria

1. A pre-scope initialization failure terminalizes the run without mutating any property coverage row.
2. A post-scope terminal failure updates the run and eligible matching-version property attempt coverage in one transaction.
3. A forced exception between run update and coverage update leaves neither side partially committed.
4. A property whose identifier version changed after the run snapshot receives no stale failed-attempt publication from that run.
5. A directly failed snapshot BIN produces the concrete failure reason for properties requiring that BIN.
6. A property whose own snapshot BINs succeeded but whose run was rejected receives `RUN_NOT_PROMOTED` unless the run reason is `SOURCE_CHANGED`, in which case `SOURCE_CHANGED` is published.
7. A previous successful run remains the `last_success_*` and live-state source after a later FAILED/SOURCE_CHANGED run.
8. Staging/live rows are unchanged by terminal failure publication.

# Verification

The integration test uses real PostgreSQL fixtures for pre-scope/post-scope failures, version changes, failed-batch attribution and rollback injection. No live NYC request is required.
