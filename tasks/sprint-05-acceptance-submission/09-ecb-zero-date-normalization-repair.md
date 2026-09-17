---
id: S5-T9
stage: 5
model_class: hard_worker
timeout_minutes: 75
review: true
allow_protected: false
depends_on:
  - S5-T8
allowed_paths:
  - src/services/ecb/normalization.service.ts
  - tests/unit/ingestion/ecb-normalization.test.ts
  - tests/integration/ingestion/raw-staging.persistence.test.ts
context:
  - architecture.ingestion_strategy
  - architecture.storage
  - architecture.testing
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

Repair the live DOB ECB date-compatibility defect exposed by S5-T3 without
weakening strict normalization or changing raw-source provenance.

# Proven failure

The 10,000-property acceptance persisted source row `319877` to
`ecb_violation_raw`, but the row did not reach staging because its live
`issue_date` value is the string `"0"`.

A bounded live source probe on 2026-09-17 found 64 rows with
`issue_date="0"`, including row `319877`. These are source records, not a
one-off fixture. The normalized model already permits `issueDate = null`.

# Scope

Treat only the verified DOB ECB `ISSUE_DATE` sentinel `"0"` as no normalized
issue date:

- the raw payload must continue to preserve the exact source value `"0"`;
- normalization maps that sentinel to `issueDate = null`;
- empty/null issue dates keep their existing nullable behavior;
- valid supported date formats keep their existing behavior;
- arbitrary malformed or impossible dates remain explicit normalization
  failures.

Add focused unit coverage and real-PostgreSQL raw/staging coverage proving that
the sentinel row is raw-persisted and stages with `issue_date = NULL`, including
idempotent replay.

# Out of scope

Do not:

- broadly coerce invalid dates to NULL;
- add special handling for `served_date`, `hearing_date`, or unrelated source
  fields;
- change Socrata query shape, pagination, retry or batch bounds;
- change raw-before-normalization ordering;
- change live promotion, reconciliation or terminal publication;
- modify S5-T3 runner, seed or evidence.

# Acceptance criteria

1. Exact source `ISSUE_DATE == "0"` normalizes to `issueDate = null`.
2. The raw payload still contains the exact source value `"0"`.
3. The row stages successfully with a SQL NULL issue date.
4. Replaying the same source identity/version remains idempotent.
5. Existing invalid-date cases such as impossible calendar dates still fail.
6. Existing normalization and raw/staging tests continue to pass.

# Verification note

This task is deterministic and must not run the 10,000-property benchmark.
S5-T3 remains the single fresh live acceptance rerun after both CR-0008 repairs
are integrated.
