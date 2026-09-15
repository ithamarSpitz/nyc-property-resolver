---
id: S1-T9
stage: 4
model_class: hard_worker
timeout_minutes: 55
review: true
allow_protected: false
depends_on:
  - S1-T7
allowed_paths:
  - src/services/property-resolver/bulk-property-registration.service.ts
  - src/services/property-resolver/property-identity.service.ts
  - src/routes/properties-bulk.routes.ts
  - src/schemas/property-bulk.schema.ts
  - src/clients/pluto.client.ts
  - src/clients/building-footprints.client.ts
  - src/clients/condo-units.client.ts
  - src/clients/condominiums.client.ts
  - tests/unit/property-resolution/bulk-property-registration.service.test.ts
  - tests/api/properties.bulk.test.ts
  - tests/integration/property-resolution/bulk-property-registration.persistence.test.ts
context:
  - architecture.api
  - architecture.resolver
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/property-resolution/bulk-property-registration.service.test.ts tests/api/properties.bulk.test.ts
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/property-resolution/bulk-property-registration.persistence.test.ts
---

# Goal

Implement the dedicated bounded bulk-BBL registration path used for large portfolio import, without degenerating into 10,000 calls to the single-property network flow.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md` and the public APIs of the already-integrated S1 clients/persistence boundary.

# Scope

Implement:

- `POST /properties/bulk` request validation for up to 10,000 BBLs;
- validation/canonicalization and input deduplication before external work;
- a dedicated bulk registration service that skips GeoSearch;
- deterministic bounded chunking for source queries;
- bulk/batched lookup methods in PLUTO, Building Footprints, and condo mapping clients where required by parcel classification;
- joining source results in application code by canonical identifiers;
- explicit per-input success/failure accounting suitable for a bulk response;
- bulk PostgreSQL persistence through the existing property identity boundary, preserving the same uniqueness, BIN filtering, identifier-version, and coverage semantics as single registration;
- idempotent replay of the same BBL batch.

The service must have an observable bounded-query shape in tests: external-source call count grows by chunks, not one request per input property.

# Out of scope

Do not implement:

- the S5 `seed:scale` command or the real 10,000-property acceptance run;
- GeoSearch in the bulk path;
- ingestion;
- main-app route mounting (Stage 5 owns final wiring);
- a generic ingestion/bulk framework unrelated to property registration.

# Invariants

- Maximum request size is 10,000 BBLs.
- Input is deduplicated before external queries.
- GeoSearch is never invoked for bulk BBL registration.
- Source queries are explicitly bounded/chunked.
- Bulk persistence reuses canonical property rows and the same BIN/coverage invariants as single-property resolution.
- No external call-per-property implementation is acceptable.

# Acceptance criteria

1. The API rejects payloads over 10,000 BBLs and malformed BBL entries.
2. Duplicate BBLs are deduplicated before source access.
3. Tests prove the service uses bounded chunk calls rather than a per-BBL external request loop.
4. The bulk path queries PLUTO/footprints/condo mapping as needed and never calls GeoSearch.
5. Re-running the same batch creates no duplicate property/input/BIN records.
6. Multi-BIN and zero-valid-BIN properties preserve the same persistence/coverage semantics as the single resolver.
7. The persistence test runs against real PostgreSQL; source clients remain mocked.
8. The route exposes structured per-input outcomes appropriate for partial source resolution failures without hiding them.

# Verification

Focused unit/API tests prove request shape and bounded calls; the integration test proves idempotent bulk persistence against real PostgreSQL.
