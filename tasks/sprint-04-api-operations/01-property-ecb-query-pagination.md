---
id: S4-T1
stage: 1
model_class: worker
timeout_minutes: 55
review: true
allow_protected: false
depends_on: []
allowed_paths:
  - src/db/property-violations-query.repository.ts
  - src/services/ecb/property-violations-query.service.ts
  - src/schemas/property-violations-query.schema.ts
  - tests/integration/api/property-violations-query.test.ts
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
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/api/property-violations-query.test.ts
---

# Goal

Implement the local-store property ECB query primitive, including exact filter semantics, coverage/freshness lookup, stable newest-first ordering, and NULL-aware keyset pagination.

# Required context

Read only the context aliases in the frontmatter plus `AGENTS.md` and the S3 live-state/coverage contracts already implemented in the repository.

# Scope

Implement a typed query schema, repository and service for the data needed by:

```http
GET /properties/:id/ecb-violations
```

The query path must:

- read only PostgreSQL live state; never call Socrata or any NYC resolution source;
- select only `ecb_violations.is_current = true` rows associated with the requested property's currently persisted BIN relationships;
- support independent `openOnly=true` and `unpaidOnly=true` filters where:
  - `openOnly=true` means `ecb_violation_status = 'ACTIVE'`;
  - `unpaidOnly=true` means `balance_due > 0`;
- order exactly by:

```sql
ORDER BY issue_date DESC NULLS LAST, source_id DESC
```

- implement a cursor encoding/decoding the last `(issue_date, source_id)` pair;
- implement the architecture's two explicit NULL-aware next-page branches instead of a plain tuple comparator;
- return page metadata sufficient for the route layer to expose the next cursor;
- load the property's ECB coverage/freshness state independently of whether the violations list is empty, preserving checked-empty vs not-checked vs failed semantics;
- reject malformed cursor/limit/filter inputs through the typed query schema;
- enforce a bounded positive page size rather than allowing unbounded reads.

# Out of scope

Do not implement:

- Express route wiring;
- portfolio-wide ECB querying;
- scheduler/manual ingestion;
- any external HTTP call;
- historical/deletion feeds.

# Invariants

- Querying stored ECB data never calls NYC APIs.
- Staging rows are never served.
- A property with no current violations may still be `CHECKED`; an empty list alone is not coverage.
- Dated rows always precede `issue_date IS NULL` rows.
- Pagination must traverse from dated rows into the NULL tail and continue within the NULL tail without skips or duplicates.

# Acceptance criteria

1. `openOnly` and `unpaidOnly` work independently and together with exact architecture semantics.
2. Results are exactly `issue_date DESC NULLS LAST, source_id DESC`.
3. A multi-page fixture crosses from dated rows into the first NULL-date row without duplicate/omitted source IDs.
4. Pagination continues for multiple pages entirely inside the NULL tail.
5. A malformed cursor, invalid boolean or invalid limit is rejected before repository execution.
6. Coverage distinguishes at least `CHECKED + empty`, `NOT_CHECKED`, and `FAILED`, retaining the last-success fields established by S3.
7. The test installs a fail-fast/mock external-client seam proving this query path does not invoke Socrata/GeoSearch/PLUTO/Footprints/condo clients.

# Verification

Use real PostgreSQL for ordering/keyset behavior. The test must compare the complete traversed source-ID sequence against one canonical expected ordering, not only page lengths.
