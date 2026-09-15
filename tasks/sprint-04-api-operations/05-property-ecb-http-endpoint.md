---
id: S4-T5
stage: 2
model_class: worker
timeout_minutes: 50
review: true
allow_protected: false
depends_on:
  - S4-T1
  - S4-T4
allowed_paths:
  - src/routes/properties.routes.ts
  - tests/api/properties.ecb-violations.test.ts
context:
  - architecture.api
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/api/properties.ecb-violations.test.ts
---

# Goal

Expose the property-scoped ECB query service through the required HTTP endpoint with validated query parameters, stable pagination output, and explicit coverage/freshness metadata.

# Required context

Read only the context aliases listed above plus `AGENTS.md`, the existing property route conventions from S1, S4-T1 query service/schema, and S4-T4 error conventions.

# Scope

Extend the existing property routes with:

```http
GET /properties/:id/ecb-violations
```

The endpoint must:

- validate property ID and query parameters through existing/typed Zod schemas;
- accept `openOnly`, `unpaidOnly`, `cursor`, and bounded `limit`;
- delegate all ordering/filter/keyset logic to S4-T1 instead of rebuilding SQL in the route;
- return violations from local storage plus an explicit coverage/freshness object that distinguishes checked-empty, not-checked and failed-fetch states;
- expose a next cursor only when another page exists;
- use the shared HTTP error conventions;
- return a sensible not-found response when the stored property does not exist;
- never call an external NYC service during this GET path.

# Out of scope

Do not implement:

- portfolio-wide endpoint;
- manual ingestion endpoint;
- new query semantics not already owned by S4-T1;
- real-network acceptance.

# Invariants

- The route is a thin HTTP adapter over the local-store query service.
- Empty `violations` is never the only data-quality signal.
- `openOnly` and `unpaidOnly` remain independent.

# Acceptance criteria

1. Supertest proves open-only, unpaid-only and combined filtering through the HTTP contract.
2. Supertest proves exact newest-first traversal including dated→NULL-tail pagination and NULL-tail continuation.
3. `CHECKED + []`, `NOT_CHECKED + []`, and `FAILED + []` produce distinguishable coverage metadata.
4. Malformed booleans/cursors/limits are rejected with safe client errors.
5. Unknown property ID returns the agreed not-found response.
6. The test fails if any external NYC client is invoked.

# Verification

Use Supertest with real PostgreSQL fixtures; upstream clients must be mocked/fail-fast.
