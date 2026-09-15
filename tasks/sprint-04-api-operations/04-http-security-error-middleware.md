---
id: S4-T4
stage: 1
model_class: worker
timeout_minutes: 40
review: true
allow_protected: false
depends_on: []
allowed_paths:
  - src/middleware/security.middleware.ts
  - src/middleware/error.middleware.ts
  - tests/unit/http/security-error-middleware.test.ts
context:
  - architecture.operations
  - architecture.data_access_validation
  - architecture.testing
environment: null
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/http/security-error-middleware.test.ts
---

# Goal

Implement reusable HTTP security/error middleware primitives required by the architecture without yet wiring final application routes.

# Required context

Read only the listed context aliases plus `AGENTS.md` and the S0 config/logger/error foundation.

# Scope

Implement middleware/factories for:

- Helmet security headers;
- `express-rate-limit` using the validated configured API rate limit representation;
- explicit JSON request body limit using the validated `API_BODY_LIMIT` value (architecture default `512kb` comes from the config boundary, not a duplicate hard-coded default here);
- generic client-facing error mapping with no stack traces or internal database/upstream detail;
- detailed structured internal logging through the shared logger;
- Zod/application-error mapping appropriate for route validation failures;
- a composition shape that S4-T7 can wire into `app.ts` in deterministic order.

# Out of scope

Do not implement:

- authentication;
- route/business logic;
- final `app.ts` composition;
- changes to architecture-owned config defaults;
- raw SQL construction.

# Invariants

- No secrets, connection strings, stack traces or full upstream payloads are returned to clients.
- Middleware does not create a second configuration source.
- Body size is explicitly bounded before route business logic.
- Authentication remains out of scope.

# Acceptance criteria

1. Middleware tests prove standard security headers are installed.
2. Body-limit configuration is consumed from the shared config boundary and rejects an oversized JSON request in the test harness.
3. Rate limiting uses configuration rather than an inline magic production value.
4. Zod/application failures map to stable client responses without leaking stack traces.
5. Internal logging receives detailed error context while the client response remains generic.

# Verification

A small temporary Express app inside the unit test is sufficient; final application wiring belongs to S4-T7.
