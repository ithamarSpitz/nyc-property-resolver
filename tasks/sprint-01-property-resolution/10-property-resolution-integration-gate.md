---
id: S1-T10
stage: 5
model_class: hard_worker
timeout_minutes: 60
review: true
allow_protected: false
depends_on:
  - S1-T8
  - S1-T9
allowed_paths:
  - src/app.ts
  - package.json
  - scripts/verify-property-resolution.mjs
  - tests/fixtures/property-resolution/**
  - tests/integration/property-resolution/property-resolution.behavior.test.ts
  - tests/api/properties.e2e.test.ts
context:
  - architecture.resolver
  - architecture.api
  - architecture.testing
environment: docker
verification:
  - npm run verify:property-resolution
---

# Goal

Integrate the complete S1 property-registration surface and establish one reproducible behavior gate proving that identity, resolver, single HTTP registration, and bounded bulk registration work together without live NYC network dependence.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md` and the already-integrated S1 implementation.

# Scope

Wire the Stage-4 property routers into the existing Express app without duplicating their business logic.

Create a cross-platform `scripts/verify-property-resolution.mjs` and `npm run verify:property-resolution` that verifies S1 from an integrated checkout. The gate must include:

- typecheck and Prisma validation;
- the complete S1 focused Jest/Supertest suites;
- real PostgreSQL migration/application state in an isolated Compose namespace;
- resolver service integration with mocked NYC clients;
- full `POST /properties` -> resolver -> PostgreSQL -> `GET /properties/:id` behavior;
- explicit Express JSON body limit using the configured `API_BODY_LIMIT` (default `512kb`) so the 10,000-BBL bulk contract does not depend on Express defaults;
- duplicate create/idempotency behavior;
- Queens hyphen preservation;
- condo-unit exact-match behavior plus explicit ambiguous/unmatched failure;
- matching/mismatching footprint parcel evidence;
- GeoSearch BIN contradiction behavior;
- zero-valid-BIN and valid-BIN coverage initialization;
- alias-only registration preserving identifier version/coverage;
- effective BIN-set change atomically incrementing `identifier_version` and invalidating coverage;
- bulk BBL request validation, deduplication, bounded-source-call shape, and idempotent persistence.

The verification script must clean temporary Docker resources in a `finally`/equivalent path on both success and failure.

# Out of scope

Do not implement:

- live NYC acceptance/seed properties;
- BIS spot checks;
- the 10,000-property real scale run;
- ECB ingestion;
- S4 violation-query endpoints;
- fixes to prior task-owned production files unless integration evidence is turned into an explicit focused correction/plan change.

If this integration gate reveals a defect in a path owned by an earlier task, stop with a precise Stage/Task failure rather than silently broadening this task to rewrite that component.

# Invariants

- Automated S1 verification is deterministic and does not require NYC network availability.
- PostgreSQL semantics that matter to identity/version/coverage are tested against real PostgreSQL.
- Main app wiring remains thin; resolver/bulk business logic stays in services.
- The behavior gate verifies the same canonical identity rules used by both single and bulk registration.
- Docker cleanup occurs on success and failure.

# Acceptance criteria

1. `npm run verify:property-resolution` passes from an integrated S1 checkout with Docker available.
2. `POST /properties` and `GET /properties/:id` work end-to-end against real PostgreSQL with mocked external NYC clients.
3. Duplicate normalized input and duplicate canonical BBL behavior is idempotent.
4. Queens, condo, footprint-conflict, GeoSearch-conflict, zero-BIN, alias-only, and BIN-set-version behaviors are all explicitly asserted.
5. Bulk registration proves deduplication and bounded source-call shape and does not use GeoSearch/per-property network calls; the integrated app uses the configured JSON body limit rather than Express defaults.
6. The full S1 automated suite leaves no temporary Compose environment/volumes behind after the verification script exits.
7. No S2 ingestion implementation is introduced.

# Verification

This task is the S1 behavior gate. The Harness executes `npm run verify:property-resolution` again after the task is merged into the Stage-5 integration checkout.
