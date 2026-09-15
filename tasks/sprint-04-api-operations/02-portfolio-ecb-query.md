---
id: S4-T2
stage: 1
model_class: worker
timeout_minutes: 55
review: true
allow_protected: false
depends_on: []
allowed_paths:
  - src/db/portfolio-violations-query.repository.ts
  - src/services/ecb/portfolio-violations-query.service.ts
  - src/schemas/portfolio-violations-query.schema.ts
  - tests/integration/api/portfolio-violations-query.test.ts
context:
  - architecture.api
  - architecture.storage
  - architecture.data_access_validation
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/api/portfolio-violations-query.test.ts
---

# Goal

Implement the portfolio-wide live ECB query primitive with current-watchlist membership filtering, `updatedSince` source-update semantics, unpaid filtering, and stable cursor pagination.

# Required context

Read only the context aliases in the frontmatter plus `AGENTS.md` and the S3 live-state contracts.

# Scope

Implement the query schema, repository and service behind:

```http
GET /ecb-violations
```

The primitive must:

- read only local PostgreSQL;
- return violation-level rows, not property×violation expansion;
- require `is_current = true`;
- require current portfolio membership through an `EXISTS` relationship to live `property_bins` for the violation BIN;
- therefore exclude a live violation row whose BIN is no longer associated with any currently tracked property;
- support `unpaidOnly=true => balance_due > 0`;
- support optional `updatedSince`, defined strictly as:

```text
source_row_updated_at > supplied timestamp
```

and never as `issue_date` or local `updated_at`;
- when `updatedSince` is present, order exactly by `source_row_updated_at DESC, source_id DESC` and keyset paginate on that same pair;
- use a deterministic stable order/cursor for the no-`updatedSince` case as defined by the implementation while preserving all architecture live-membership semantics;
- validate cursor/timestamp/limit/filter input and bound page size;
- emit each violation once even when its BIN belongs to multiple tracked properties.

# Out of scope

Do not implement:

- Express route wiring;
- property-scoped coverage responses;
- change/deletion event history;
- property×violation result expansion;
- external source access.

# Invariants

- `is_current` is source-current state for a scanned BIN, not sufficient portfolio membership by itself.
- `updatedSince` is a Socrata source-row update filter using persisted `source_row_updated_at`.
- The core endpoint is not a deletion/history feed.
- Shared BIN membership must not duplicate a violation row.

# Acceptance criteria

1. A current violation whose BIN no longer exists in any live `property_bins` row is excluded.
2. A current violation on a BIN shared by multiple properties appears exactly once.
3. `is_current = false` rows are excluded.
4. `unpaidOnly=true` excludes zero/negative balance rows.
5. `updatedSince` compares against `source_row_updated_at`, with boundary equality excluded because the contract is strictly `>`.
6. `updatedSince` pages preserve exact `source_row_updated_at DESC, source_id DESC` ordering without duplicates/skips.
7. No external NYC client is invoked by this query path.

# Verification

Use real PostgreSQL so `EXISTS`, deduplication and keyset behavior are verified against the actual database semantics.
