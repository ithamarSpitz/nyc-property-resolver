---
id: S8-T1
stage: 1
model_class: hard_worker
timeout_minutes: 60
review: true
allow_protected: false
depends_on: []
allowed_paths:
  - src/services/property-resolver/condo-resolution.service.ts
  - src/services/property-resolver/property-resolver.service.ts
  - src/services/property-resolver/bulk-property-registration.service.ts
  - tests/fixtures/property-resolution/scenarios.ts
  - tests/integration/property-resolution/property-resolver.service.test.ts
  - tests/integration/property-resolution/property-resolution.behavior.test.ts
  - tests/integration/property-resolution/bulk-property-registration.persistence.test.ts
  - tests/unit/property-resolution/bulk-property-registration.service.test.ts
context:
  - assignment
  - architecture.resolver
  - architecture.data_access_validation
environment: docker
verification:
  - npm run typecheck
  - npm run verify:property-resolution
---

# Goal

Fix condominium-unit resolution so PLUTO validates the condominium billing parcel rather than requiring the unit BBL itself to exist in PLUTO.

This is a real-data regression repair discovered by the clean acceptance run after S6.

# Proven live evidence

For the Downtown Club acceptance fixture:

- input address: `20 West Street, Manhattan, NY Apt 12C`
- authoritative condo base BBL: `1000150019`
- authoritative condo billing BBL: `1000157502`
- authoritative unit BBL for unit 12C: `1000151137`
- GeoSearch building BIN: `1087243`

The S6 reverse billing-to-base repair is working: the live resolver now reaches unit BBL `1000151137`.

However, the live request then fails with:

```text
RESOLVER_PLUTO_NOT_FOUND
PLUTO did not contain parcel 1000151137
```

Direct NYC PLUTO checks prove:

```text
PLUTO bbl=1000151137
-> no row

PLUTO bbl=1000157502
-> one row
   bbl      1000157502
   borocode 1
   block    15
   lot      7502
   address  20 WEST STREET
   bldgclass RM
```

Therefore the current assumption that a condominium unit BBL must itself be present in PLUTO is invalid for this real supported fixture.

# Required behavior

## Single-property condo resolution

For a resolved condominium unit:

1. Resolve the unit BBL through Condominium Units.
2. Resolve the authoritative condo base BBL.
3. Resolve the condo billing BBL through the Condominiums dataset.
4. Query/validate PLUTO using the **condo billing BBL**, not the unit BBL.
5. Continue Building Footprints lookup by condo base BBL and existing condo `MAPPLUTO_BBL` validation against the billing BBL.
6. Persist the canonical property as the **unit BBL**.

The PLUTO parcel is building/billing evidence. It is not the canonical identity of the unit.

## Persisted unit identity

A property representing a condo unit must preserve internally consistent identifiers:

- `properties.bbl = unitBbl`
- `condo_base_bbl = condoBaseBbl`
- `condo_billing_bbl = condoBillingBbl`
- `normalized_address` may use the authoritative billing-parcel PLUTO address
- `borough`, `block`, and `lot` must represent the canonical **unit BBL**, not the billing parcel

Derive the unit's borough/block/lot from the validated canonical unit BBL rather than copying billing-parcel PLUTO components. For Downtown Club this means lot `1137`, not billing lot `7502`.

## Direct unit-BBL flow

A direct condo unit BBL must follow the same semantics. It must not fail merely because the unit BBL has no PLUTO row when its authoritative billing BBL has a valid PLUTO parcel.

## Bulk BBL registration

The bulk condo-unit path currently also obtains PLUTO evidence using input/unit BBLs. Repair it consistently:

- do not require PLUTO rows for condo unit BBLs;
- after authoritative unit -> base -> billing mapping is known, perform bounded/batched PLUTO lookup for the required condo billing BBLs;
- retain the existing bounded-query design and chunking principles;
- keep ordinary non-condo PLUTO lookup behavior unchanged;
- persist unit BBL identity/components while using billing PLUTO address/evidence.

Do not degrade bulk registration into one external network request per condo unit.

# Regression tests

Add tests that would have failed before this repair.

At minimum cover:

1. **Live-shape address regression**
   - GeoSearch billing BBL `1000157502`
   - reverse mapping -> base `1000150019`
   - unit designation `12C` -> unit BBL `1000151137`
   - PLUTO lookup for unit BBL is unavailable/not found
   - PLUTO lookup for billing BBL succeeds
   - resolution succeeds
   - assert PLUTO is queried with billing BBL, not unit BBL
   - persisted property uses unit BBL and unit lot `1137`
   - persisted address may be `20 WEST STREET`
   - validated BIN remains `1087243`

2. **Direct unit-BBL regression**
   - same distinction between unit identity and billing PLUTO evidence
   - direct unit BBL resolves successfully without a PLUTO row for the unit BBL

3. **Billing PLUTO failure**
   - if the authoritative billing BBL is absent/incomplete in PLUTO, preserve explicit PLUTO failure semantics
   - the error should identify the billing BBL actually queried

4. **Bulk condo-unit regression**
   - bulk condo registration uses billing BBL PLUTO evidence
   - does not require a unit-BBL PLUTO record
   - does not persist billing lot/components as unit identity
   - ordinary non-condo bulk behavior remains unchanged

Mocks must reflect the real NYC source relationship. Do not mock a PLUTO row for `1000151137` merely to make the test pass.

# Preserve

Do not change:

- S6 authoritative billing-to-base reverse lookup behavior;
- zero/multiple condo mapping ambiguity failures;
- Building Footprints base-BBL lookup behavior;
- condo `MAPPLUTO_BBL` validation against billing BBL;
- GeoSearch BIN corroboration;
- normalized-input idempotency;
- property/BIN versioning and coverage invalidation semantics;
- non-condo resolver behavior;
- database schema or migrations;
- seed evidence values merely to avoid this failure.

# Acceptance criteria

1. The Downtown Club data relationship is represented correctly in tests.
2. Condo unit resolution queries PLUTO using the billing BBL.
3. A missing unit-BBL PLUTO row is no longer a resolution failure by itself.
4. The persisted canonical property remains the unit BBL.
5. Persisted borough/block/lot are consistent with the unit BBL, not the billing BBL.
6. Direct condo-unit BBL resolution obeys the same rules.
7. Bulk condo-unit registration obeys the same rules without per-item PLUTO calls.
8. Existing ambiguity and identifier-conflict behavior is preserved.
9. `npm run typecheck` passes.
10. `npm run verify:property-resolution` passes.
