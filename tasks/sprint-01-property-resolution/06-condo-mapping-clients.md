---
id: S1-T6
stage: 2
model_class: worker
timeout_minutes: 40
review: true
allow_protected: false
depends_on:
  - S1-T1
allowed_paths:
  - src/clients/condo-units.client.ts
  - src/clients/condominiums.client.ts
  - tests/unit/clients/condo-units.client.test.ts
  - tests/unit/clients/condominiums.client.test.ts
context:
  - architecture.resolver
  - architecture.data_access_validation
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/clients/condo-units.client.test.ts tests/unit/clients/condominiums.client.test.ts
---

# Goal

Implement the two Digital Tax Map client boundaries needed for explicit condominium unit/base/billing resolution.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`.

The architectural source contracts are:

- Condominium Units dataset `eguu-7ie3`: unit BBL -> condo base BBL, and unit-designation lookup within the relevant condo/base context;
- Condominiums dataset `p8u6-a6it`: condo base BBL -> condo billing BBL.

# Scope

Implement:

- `CondoUnitsClient` for exact unit-BBL lookup and bounded lookup by condo/base context plus unit designation;
- `CondominiumsClient` for condo-base -> condo-billing mapping;
- typed parsing preserving BBL strings/padding;
- explicit zero/one/multiple match results so orchestration can reject unmatched or ambiguous unit resolution;
- timeout, HTTP-status, request-construction, and minimal response validation.

All automated tests mock `fetch`.

# Out of scope

Do not implement:

- deciding whether an arbitrary parcel is a condo;
- full condo resolver orchestration;
- Building Footprints or PLUTO validation;
- property persistence;
- silent selection among multiple unit matches.

# Invariants

- Condo unit resolution is explicit; unit lot and building/billing parcel are not treated as interchangeable.
- An address-unit lookup must preserve multiple matches so the resolver can fail ambiguity explicitly.
- BBL values remain canonical strings.

# Acceptance criteria

1. Unit BBL lookup parses `CONDO_BASE_BBL` correctly.
2. Base-context + unit-designation lookup returns zero/one/multiple matches without guessing.
3. Condo-base lookup parses `CONDO_BILLING_BBL` correctly.
4. Timeout/non-2xx/malformed-source cases are explicit and tested for both clients.
5. Tests confirm no arbitrary candidate selection occurs inside either client.

# Verification

The focused mocked-client suites and typecheck must pass.
