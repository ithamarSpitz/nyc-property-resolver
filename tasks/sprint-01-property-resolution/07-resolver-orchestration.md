---
id: S1-T7
stage: 3
model_class: hard_worker
timeout_minutes: 55
review: true
allow_protected: false
depends_on:
  - S1-T2
  - S1-T3
  - S1-T4
  - S1-T5
  - S1-T6
allowed_paths:
  - src/services/property-resolver/property-resolver.service.ts
  - src/services/property-resolver/condo-resolution.service.ts
  - src/services/property-resolver/footprint-validation.ts
  - tests/unit/property-resolution/footprint-validation.test.ts
  - tests/integration/property-resolution/property-resolver.service.test.ts
context:
  - architecture.resolver
  - architecture.storage
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/property-resolution/footprint-validation.test.ts
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/property-resolution/property-resolver.service.test.ts
---

# Goal

Implement the deterministic resolver orchestration that composes normalized inputs, NYC source clients, identifier cross-checks, condo flows, and the S1 persistence boundary into one idempotent address/BBL resolution service.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md` and the already-integrated S1 source files needed to call their public APIs.

# Scope

Implement resolver orchestration for:

- normalized-input lookup before any external call;
- normal address resolution through GeoSearch -> canonical parcel context -> PLUTO -> Building Footprints;
- direct BBL input resolution without GeoSearch;
- condo unit BBL resolution through Condo Units -> condo base -> Condominiums/billing context -> footprint/PLUTO-compatible validation;
- unit-aware address resolution by:
  - GeoSearch on the base address;
  - resolving building/condo base context;
  - filtering Condo Units by that context and normalized unit designation;
  - requiring exactly one unit match;
  - continuing through the existing condo-unit BBL path;
- deterministic candidate selection with explicit unresolved/ambiguous errors rather than guessing;
- non-condo Building Footprints cross-check:
  - prefer `MAPPLUTO_BBL` when present and require equality with canonical PLUTO BBL;
  - otherwise require `BASE_BBL` equality;
  - reject mismatch explicitly;
- GeoSearch BIN as corroborating evidence only; a direct contradiction with validated footprint mapping must fail explicitly;
- filtering placeholder BINs before persistence;
- persisting canonical property, effective valid BIN set, normalized input mapping, resolver confidence/metadata, and coverage through the Stage-1 persistence boundary;
- explicit dependency injection/construction boundaries for NYC clients and persistence so automated tests can substitute mocks without global monkey-patching.

Use real PostgreSQL in integration tests and mocked NYC clients. Tests must prove that a repeated normalized input returns the stored mapping without a second external resolution.

# Out of scope

Do not implement:

- HTTP routes;
- bulk registration;
- live NYC network acceptance;
- ingestion logic;
- alternate/fuzzy resolver strategies not present in the architecture.

Do not bypass `property-identity.service.ts` by writing `property_bins` directly.

# Invariants

- Resolve-once is enforced by checking the normalized input mapping before external calls.
- Same canonical BBL maps to one canonical property row.
- Ambiguous/unmatched condo-unit inputs fail explicitly.
- Valid non-condo footprint candidates must agree with canonical parcel identity.
- GeoSearch/footprint identifier contradictions are never silently reconciled by guessing.
- Alias-only registration does not invalidate coverage.
- A zero-valid-BIN resolution remains `NOT_CHECKED / NO_VALID_BIN`, never `CHECKED + empty`.

# Acceptance criteria

1. Repeating the same normalized address returns the same property and performs no second NYC-client resolution.
2. Direct BBL input resolves without invoking GeoSearch.
3. A normal non-condo address accepts matching PLUTO/footprint identifiers and persists all valid BINs.
4. A `MAPPLUTO_BBL` mismatch fails explicitly.
5. When `MAPPLUTO_BBL` is absent, a mismatching `BASE_BBL` fails explicitly.
6. A direct GeoSearch BIN contradiction with validated footprint evidence fails explicitly.
7. Condo-unit BBL resolution persists unit/base/billing context and building BINs through the documented flow.
8. A unit-aware address requires exactly one matching condo unit; zero or multiple matches fail explicitly.
9. Two different units in the same building remain distinct normalized resolution inputs.
10. Placeholder-only/no-valid-BIN resolution produces explicit `NO_VALID_BIN` coverage.
11. Integration tests use real PostgreSQL but mocked external NYC APIs through explicit service dependencies rather than hidden global state.

# Verification

The focused unit test validates footprint rules; the integration suite validates end-to-end resolver service behavior against real PostgreSQL without live NYC network dependency.
