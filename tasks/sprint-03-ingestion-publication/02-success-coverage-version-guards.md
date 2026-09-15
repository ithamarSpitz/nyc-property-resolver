---
id: S3-T2
stage: 2
model_class: hard_worker
timeout_minutes: 60
review: true
allow_protected: false
depends_on:
  - S3-T1
allowed_paths:
  - src/services/ecb/successful-coverage.service.ts
  - tests/integration/ingestion/successful-coverage.test.ts
context:
  - architecture.resolver
  - architecture.storage
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/ingestion/successful-coverage.test.ts
---

# Goal

Implement the transaction-aware successful-coverage primitive for an accepted run, deriving property scope only from the immutable run snapshot and enforcing the property `identifier_version` guard before any property becomes `CHECKED` for that run.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`, S1's identifier-version mutation boundary, and the integrated S2 run-snapshot persistence.

# Scope

Implement `successful-coverage.service.ts` as a primitive that receives an existing database transaction and accepted run `R` and publishes success-side property coverage according to the architecture:

- derive the run's property/BIN requirements only from `ingestion_run_property_bins` for `R`, never current live `property_bins`;
- require the run to have complete trustworthy BIN processing before success coverage is eligible;
- for each snapshotted property, compare current `properties.identifier_version` with the snapshotted `property_identifier_version`;
- when versions match and the accepted run established complete scope:
  - set coverage `status=CHECKED`;
  - publish the current run as the latest attempt and latest complete success;
  - publish the accepted dataset-level source watermark/freshness value;
  - clear stale failure state as appropriate to the existing coverage schema;
- when the current identifier version no longer matches the snapshot:
  - do **not** publish the run as a successful coverage result for that newer identifier state;
  - ensure coverage remains/becomes `NOT_CHECKED` with `status_reason=IDENTIFIERS_CHANGED_AFTER_SNAPSHOT` as specified;
  - do not overwrite a newer coverage state with stale run semantics;
- leave zero-valid-BIN properties alone: they are not present in the run snapshot and retain the S1 registration-path `NO_VALID_BIN` behavior.

Keep this service transaction-aware and free of an independent outer transaction so S3-T3 can compose it atomically with live promotion/reconciliation and run completion.

# Out of scope

Do not implement:

- staging -> live row promotion;
- negative reconciliation;
- `COMPLETED` run transition;
- FAILED/SOURCE_CHANGED coverage publication;
- HTTP response formatting;
- property BIN-set mutation; S1 remains the sole owner of that transaction.

# Invariants

- Run coverage requirements come from the immutable run Property<->BIN snapshot, never the current watchlist.
- Successful coverage requires the current property identifier version to equal the snapshotted version.
- A run can be accepted at run level while an individual property remains/not becomes `CHECKED` because its identifiers changed after snapshot.
- Successful coverage freshness is the accepted dataset-level watermark, not a row-level `:updated_at`.
- `NO_VALID_BIN` is not converted into `CHECKED + empty` by ingestion publication.

# Acceptance criteria

1. A property with matching identifier version and all run-snapshot BINs successfully covered becomes `CHECKED` with current run attempt/success metadata and accepted dataset-level freshness.
2. Coverage is derived from `ingestion_run_property_bins`; adding a live watchlist BIN after snapshot cannot silently expand the old run's requirements.
3. If the property's identifier version changes after snapshot, the accepted run does not mark it `CHECKED`; coverage is `NOT_CHECKED / IDENTIFIERS_CHANGED_AFTER_SNAPSHOT` according to the architecture and the run is not recorded as that newer identifier state's success.
4. Existing last-success knowledge is not replaced by an ineligible stale success publication.
5. Multi-BIN property behavior is evaluated as one property scope, not one independent coverage row per BIN.
6. A `NO_VALID_BIN` property that was not snapshotted remains untouched by this success publisher.

# Verification

The integration test uses real PostgreSQL with explicit run snapshots and identifier-version changes. No live NYC request is used.
