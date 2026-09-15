---
id: S3-T3
stage: 3
model_class: hard_worker
timeout_minutes: 70
review: true
allow_protected: false
depends_on:
  - S3-T2
allowed_paths:
  - src/services/ecb/accepted-publication.service.ts
  - tests/integration/ingestion/accepted-publication.test.ts
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
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/ingestion/accepted-publication.test.ts
---

# Goal

Implement the one atomic accepted-run publication transaction that promotes staging to live, performs negative reconciliation, publishes eligible successful coverage, and transitions the run to `COMPLETED` only if the entire accepted-state transaction commits.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`, the S2 execution-authority/publication handoff, S3-T1 live-state primitive, and S3-T2 successful-coverage primitive.

# Scope

Implement `accepted-publication.service.ts` that publishes an S2 `READY_FOR_PUBLICATION` run only when the persisted run is still eligible for acceptance. It must:

- validate publication preconditions from durable state rather than blindly trusting a caller flag:
  - run is in the expected active state;
  - initialization is complete;
  - all required persisted batches are complete/successful;
  - start/end dataset watermarks are present and satisfy the architecture's unchanged best-effort guard;
- require valid S2 execution authority before beginning publication and re-check authority at the final state-changing boundary so a revoked lock owner cannot publish accepted state;
- open one short PostgreSQL transaction and, inside that same transaction:
  1. invoke S3-T1 staging promotion/live upsert;
  2. invoke S3-T1 negative reconciliation for the run-snapshot scanned BIN scope;
  3. invoke S3-T2 successful coverage publication with identifier-version guards;
  4. mark the ingestion run `COMPLETED`, persist finish time/final accepted metrics as applicable, and leave a coherent accepted terminal state;
- roll the entire transaction back if any promotion/reconciliation/coverage/terminal-state step fails;
- make a repeated publication attempt for an already-completed run safe and explicit rather than creating duplicate live rows or a second semantic completion.

# Out of scope

Do not implement:

- FAILED/SOURCE_CHANGED publication;
- batch processing/resume logic;
- scheduler/manual CLI;
- HTTP query endpoints;
- source fetching during publication.

# Invariants

- `COMPLETED` cannot become durable unless live promotion, reconciliation and eligible success coverage from the same run are durable in the same transaction.
- No accepted publication occurs when the source watermark guard fails.
- No accepted publication occurs after execution authority is revoked.
- Negative reconciliation is part of the accepted transaction and never runs for a rejected/failed run.
- A property identifier-version mismatch may prevent that property's `CHECKED` success while the run itself still completes successfully.

# Acceptance criteria

1. A fully successful, unchanged-watermark run atomically promotes staging, reconciles missing rows, publishes eligible success coverage, and ends `COMPLETED`.
2. Injecting a failure after live-row writes but before coverage/run completion rolls back live-row changes, reconciliation changes, coverage changes and run terminal state together.
3. Injecting a failure after coverage work but before the final run update also rolls the full transaction back.
4. Publication is rejected when any required batch is incomplete/failed or when start/end watermarks do not match.
5. Publication is rejected when execution authority has been revoked; no live/coverage/run terminal mutation survives.
6. A property whose identifier version changed after snapshot does not become `CHECKED`, while unaffected properties can publish success and the accepted run can still become `COMPLETED`.
7. Repeated invocation after successful completion is deterministic/idempotent and does not create duplicate live rows.

# Verification

Use real PostgreSQL and transaction-failure injection hooks/test seams. The test must prove rollback across live rows, reconciliation, coverage and run status, not only method return values.
