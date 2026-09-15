---
id: S1-T8
stage: 4
model_class: worker
timeout_minutes: 40
review: true
allow_protected: false
depends_on:
  - S1-T7
allowed_paths:
  - src/routes/properties.routes.ts
  - src/schemas/property-api.schema.ts
  - tests/api/properties.single.test.ts
context:
  - architecture.api
  - architecture.resolver
  - architecture.testing
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/api/properties.single.test.ts
---

# Goal

Implement the single-property HTTP contract for create/resolve and locally stored property lookup, while keeping HTTP concerns thin and business logic in the resolver/persistence services.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`.

# Scope

Implement an Express router/module for:

- `POST /properties` accepting exactly one of `{ address }` or `{ bbl }`;
- unit-aware address input through the same `address` field;
- Zod request validation with clear 4xx responses for malformed input;
- calling the existing resolver service and returning the canonical stored property/identifiers;
- idempotent duplicate creation semantics inherited from the resolver/persistence boundary;
- `GET /properties/:id` returning the locally stored canonical property and identifiers;
- appropriate not-found/client-error mapping without leaking internal stack traces.

Keep the router mount isolated so Stage 4 can run in parallel with the bulk path; final mounting into the main app belongs to the Stage-5 integration gate.

Tests may construct a small test Express app around this router and may mock the application service. Full resolver+DB+HTTP behavior is verified in Stage 5.

# Out of scope

Do not implement:

- `/properties/bulk`;
- ECB endpoints;
- rate-limit/security middleware changes outside existing S0 app infrastructure;
- resolver business logic in route handlers;
- app-level route mounting that would conflict with the parallel bulk task.

# Invariants

- The HTTP layer remains thin.
- `POST /properties` accepts address or BBL, not ambiguous mixed/empty payloads.
- Response data comes from the canonical resolver/persistence result.
- `GET /properties/:id` is local-store only.

# Acceptance criteria

1. Valid address and valid BBL payloads call the resolver boundary and return the canonical property shape.
2. Unit-aware address payloads are accepted without special HTTP-only resolver logic.
3. Invalid/mixed/empty property-create payloads return a validation error without calling the resolver.
4. Repeated create behavior can return the same canonical property without route-level duplication logic.
5. `GET /properties/:id` returns a stored property or a defined not-found response.
6. Supertest coverage verifies the route contract without live NYC calls.

# Verification

The route module must pass typecheck and the focused Supertest suite.
