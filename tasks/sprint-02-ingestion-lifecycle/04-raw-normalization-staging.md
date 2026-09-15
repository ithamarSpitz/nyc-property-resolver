---
id: S2-T4
stage: 2
model_class: hard_worker
timeout_minutes: 55
review: true
allow_protected: false
depends_on:
  - S2-T1
allowed_paths:
  - src/schemas/ecb.schema.ts
  - src/services/ecb/normalization.service.ts
  - src/services/ecb/raw-staging.service.ts
  - tests/unit/ingestion/ecb-normalization.test.ts
  - tests/integration/ingestion/raw-staging.persistence.test.ts
context:
  - architecture.ingestion_lifecycle
  - architecture.storage
  - architecture.data_access_validation
environment: docker
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/ingestion/ecb-normalization.test.ts
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/ingestion/raw-staging.persistence.test.ts
---

# Goal

Implement the replay-safe ECB row-processing pipeline that minimally extracts source identity, persists the raw source version first, then applies strict domain validation/normalization and upserts a run-scoped staging candidate.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md` and the S2-T1 raw/staging persistence contracts.

# Scope

Implement:

- minimal transport/source-identity extraction for `ISN_DOB_BIS_EXTRACT`, `:id`, and `:updated_at` sufficient to persist a raw row safely;
- raw persistence before strict domain parsing;
- strict Zod ECB schema validation for fields required by the normalized application model;
- normalization of dates/numbers/status/BIN/violation fields into application/database types;
- preservation of negative `balance_due` values as valid numeric data rather than coercing them away;
- run-scoped staging upsert keyed by `(run_id, source_id)`;
- replay safety when the same source version/page is processed again;
- explicit structured errors that let the batch processor fail the affected logical batch while retaining raw evidence.

Tests must use real PostgreSQL for raw/staging idempotency and mocked/plain source rows for normalization. Raw JSONB needs semantic field/value preservation, not byte-for-byte serialization equality.

# Out of scope

Do not implement:

- Socrata pagination/request loops;
- live `ecb_violations` writes;
- `is_current` semantics;
- promotion or negative reconciliation;
- property coverage publication;
- batch attempt accounting;
- source-key live verification.

# Invariants

- Raw persistence happens before strict domain validation.
- A strict validation/normalization failure never deletes or hides the persisted raw source version.
- Fetching the same `(source_id, source_row_updated_at)` repeatedly does not create duplicate raw rows.
- Reprocessing the same run/source candidate does not create duplicate staging rows.
- Staging is never served as live API state.

# Acceptance criteria

1. A valid source row is persisted raw, normalized, and written once to run-scoped staging.
2. A malformed domain row still leaves its minimally identifiable raw version persisted while normalization fails explicitly.
3. Replaying the same raw source version is idempotent.
4. Replaying the same run/source staging candidate updates/reuses one logical staging row.
5. Date/numeric parsing produces database-ready types, including valid negative balances.
6. Unit tests cover malformed required fields and representative normalization edge cases without network access.
7. Integration tests prove raw-before-strict-validation and uniqueness behavior against real PostgreSQL.

# Verification

The unit test owns normalization semantics; the PostgreSQL-backed test owns raw/staging order and idempotency semantics.
