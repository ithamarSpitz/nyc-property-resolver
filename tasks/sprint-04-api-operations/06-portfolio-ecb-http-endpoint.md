---
id: S4-T6
stage: 2
model_class: worker
timeout_minutes: 50
review: true
allow_protected: false
depends_on:
  - S4-T2
  - S4-T4
allowed_paths:
  - src/routes/violations.routes.ts
  - tests/api/violations.portfolio.test.ts
context:
  - architecture.api
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/api/violations.portfolio.test.ts
---

# Goal

Expose the portfolio-wide local ECB feed through HTTP with exact current-membership, `updatedSince`, unpaid and cursor semantics.

# Required context

Read only the listed context aliases plus `AGENTS.md`, S4-T2's query service/schema and S4-T4's shared error conventions.

# Scope

Implement:

```http
GET /ecb-violations
```

The route must:

- validate `updatedSince`, `unpaidOnly`, `cursor`, and bounded `limit`;
- delegate filtering/order/cursor behavior entirely to S4-T2;
- return a violation-level feed and next cursor where applicable;
- preserve one result for a shared-BIN violation rather than duplicating it per property;
- never expose `is_current=false` rows or rows whose BIN no longer has current portfolio membership;
- document through response shape/naming that `updatedSince` is source-row update time, not issue date or local write time;
- use shared error middleware conventions.

# Out of scope

Do not implement:

- change/deletion events;
- property×violation expansion;
- property coverage object on each portfolio row;
- source fetching.

# Invariants

- The HTTP layer does not reinterpret `updatedSince`.
- No NYC network call occurs on this route.
- Pagination order and cursor key are the same contract owned by S4-T2.

# Acceptance criteria

1. Supertest proves current-membership exclusion after removing the last live `property_bins` association for a BIN.
2. Shared-BIN violations are emitted once.
3. `updatedSince` uses persisted `source_row_updated_at` with strict `>` semantics.
4. Unpaid filtering and cursor pagination work together.
5. `is_current=false` rows are excluded.
6. Malformed query input returns safe validation errors.
7. Any external NYC-client invocation fails the test.

# Verification

Use real PostgreSQL fixtures plus Supertest. No real external requests.
