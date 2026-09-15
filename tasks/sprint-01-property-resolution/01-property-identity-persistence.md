---
id: S1-T1
stage: 1
model_class: hard_worker
timeout_minutes: 50
review: true
allow_protected: false
depends_on: []
allowed_paths:
  - prisma/schema.prisma
  - prisma/migrations/**
  - src/schemas/property-identifiers.schema.ts
  - src/services/property-resolver/property-input.service.ts
  - src/services/property-resolver/property-identity.service.ts
  - tests/unit/property-resolution/property-identifiers.test.ts
  - tests/integration/property-resolution/property-identity.persistence.test.ts
context:
  - architecture.resolver
  - architecture.storage
  - architecture.data_access_validation
environment: docker
verification:
  - npx prisma validate
  - npm run typecheck
  - npm test -- --runInBand tests/unit/property-resolution/property-identifiers.test.ts
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/property-resolution/property-identity.persistence.test.ts
---

# Goal

Establish the canonical property-identity persistence boundary: database models, BBL/BIN validation, normalized-input mappings, explicit coverage initialization, and the single transactional operation that owns effective BIN-set mutation and `identifier_version` changes.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`.

Pay particular attention to:

- BBL as the canonical parcel identifier and BIN as the ECB/watchlist building identifier;
- one property being allowed to have multiple BINs;
- placeholder BINs ending in `000000` being excluded from the effective valid BIN set;
- normalized-input idempotency being database-enforced through `property_resolution_inputs`;
- `identifier_version` changing if and only if the effective valid BIN set changes;
- coverage being explicit persisted state, including `NEVER_INGESTED`, `NO_VALID_BIN`, and `IDENTIFIERS_CHANGED`.

# Scope

Implement the first real S1 schema migration and persistence/domain boundary for:

- `properties`;
- `property_resolution_inputs`;
- `property_bins`;
- `property_dataset_coverage` fields required by property registration and later ingestion;
- logical identity constraints/indexes required by the architecture;
- BBL/BIN validation/canonicalization primitives used by property registration;
- placeholder-BIN filtering;
- lookup/persist behavior for normalized resolution inputs;
- canonical property creation/reuse by BBL;
- local canonical property lookup by id, including its valid BIN relationships, for the later GET endpoint;
- explicit coverage initialization when a property is first registered;
- one transactionally safe effective-BIN-set mutation operation that:
  - locks/serializes the property mutation appropriately;
  - compares current and next valid BIN sets;
  - leaves `identifier_version` and coverage unchanged when the set is unchanged;
  - changes `property_bins` exactly to the new set when it differs;
  - increments `identifier_version` exactly once for one effective set change;
  - invalidates current ECB coverage to `NOT_CHECKED / IDENTIFIERS_CHANGED` in the same transaction.

Write focused unit tests for BBL/BIN primitives and real-PostgreSQL integration tests for uniqueness, coverage initialization, alias behavior, and the BIN-set/version transaction.

# Out of scope

Do not implement:

- address parsing/normalization;
- GeoSearch, PLUTO, Building Footprints, or condo HTTP clients;
- property resolver orchestration;
- external source conflict handling;
- HTTP property endpoints;
- bulk BBL registration;
- ingestion-run/batch/raw/staging/live ECB tables beyond fields strictly needed by the property coverage foreign-key/domain contract.

Do not create a second mutation path that writes `property_bins` directly outside the identity service/repository boundary.

# Invariants

- `properties.bbl` is unique.
- `(property_resolution_inputs.input_type, normalized_input)` is unique.
- `(property_bins.property_id, property_bins.bin)` is unique.
- `(property_dataset_coverage.property_id, dataset)` is unique.
- Logical identity columns participating in uniqueness are non-null where required by the architecture.
- Placeholder BINs never enter the effective property BIN set.
- New property with at least one valid BIN receives `NOT_CHECKED / NEVER_INGESTED` coverage.
- New property with zero valid BINs receives `NOT_CHECKED / NO_VALID_BIN` coverage with no attempt metadata.
- Adding an input alias to an existing property does not change `identifier_version` or coverage.
- Reapplying the same valid BIN set does not change `identifier_version` or coverage.
- A real effective BIN-set change increments `identifier_version` exactly once and invalidates coverage atomically.

# Acceptance criteria

1. The committed Prisma schema/migration creates the four S1 property/coverage tables with the required constraints and indexes, with `identifier_version` initialized to 1.
2. Valid 10-digit BBLs are canonicalized/validated without losing NYC zero padding; malformed BBLs are rejected.
3. Valid BINs are canonicalized/validated and placeholder BINs ending in `000000` are excluded.
4. Repeated persistence of the same canonical BBL reuses one property row, and that canonical property can be read back by id with its valid BINs.
5. Repeated persistence of the same normalized input reuses one input mapping.
6. A valid-BIN property initializes coverage as `NOT_CHECKED / NEVER_INGESTED`; a zero-valid-BIN property initializes `NOT_CHECKED / NO_VALID_BIN`.
7. Adding only another input alias leaves identifier version and coverage unchanged.
8. Reapplying the same effective BIN set is a no-op for version/coverage.
9. Changing the effective BIN set updates the rows, increments `identifier_version` exactly once, and writes `NOT_CHECKED / IDENTIFIERS_CHANGED` in the same database transaction.
10. The focused integration test runs against real PostgreSQL, not a mocked repository.

# Verification

The YAML `verification` commands are authoritative. Docker commands run inside the Harness-provided per-task Compose namespace and are cleaned by the environment manager after the task.
