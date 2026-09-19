---
id: S6-T1
stage: 1
model_class: hard_worker
timeout_minutes: 75
review: true
allow_protected: false
depends_on: []
allowed_paths:
  - src/clients/condominiums.client.ts
  - src/services/property-resolver/condo-resolution.service.ts
  - src/services/property-resolver/property-resolver.service.ts
  - tests/unit/clients/condominiums.client.test.ts
  - tests/integration/property-resolution/**
  - tests/fixtures/property-resolution/**
context:
  - assignment
  - architecture.invariants
  - architecture.testing
  - architecture.implementation_map
environment: docker
verification:
  - npm run typecheck
  - npm run verify:property-resolution
---

# Goal

Repair the live condo-unit address-resolution defect exposed after the clean-machine README walkthrough.

The live request:

```text
20 West Street, Manhattan, NY Apt 12C
```

currently fails with:

```text
HTTP 422
code: RESOLVER_CONDO_UNIT_NOT_FOUND
message: No condominium unit matched condo base 1000150002 and unit 12C
```

The failure is caused by deriving a condo base BBL arithmetically from a condo billing BBL. This task must replace that assumption with an authoritative Condominiums-dataset reverse lookup.

# Proven live evidence

On 2026-09-19, GeoSearch returned the Manhattan candidate:

```text
label:      20 WEST STREET, New York, NY, USA
layer:      venue
confidence: 0.8
BBL:        1000157502
BIN:        1087243
borough:    Manhattan
```

The current resolver treats lot `7502` as a billing lot and derives the base lot using:

```text
7502 - 7500 = 2
=> 1000150002
```

That derived base is wrong for this condominium.

The already-recorded successful acceptance evidence for this fixture establishes:

```text
condo billing BBL: 1000157502
condo base BBL:    1000150019
unit 12C BBL:      1000151137
BIN:               1087243
```

These identifiers are regression evidence only. They must never be hard-coded in production logic.

# Required context

Read the relevant resolver/client implementation and tests, especially:

- `src/clients/condominiums.client.ts`
- `src/services/property-resolver/condo-resolution.service.ts`
- `src/services/property-resolver/property-resolver.service.ts`
- existing condo client and resolver tests
- `evidence/acceptance-small/run/registration/requests-responses.json` only as evidence of the prior successful live mapping

# Scope

Implement the smallest general repair.

1. Extend `CondominiumsClient` with an authoritative reverse lookup by condo billing BBL.
   - The lookup must query the existing Condominiums dataset by `condo_billing_bbl`.
   - It must return the associated `condo_base_bbl` using the same validated record type already used by the client.
   - Reuse existing parsing, canonicalization, timeout, app-token, and response-validation behavior rather than creating a second client path.

2. Remove the assumption that a condo base lot can be obtained by subtracting 7500 from the billing lot.
   - A billing lot identifies that a reverse mapping is required.
   - It does not encode the authoritative base lot.

3. In the unit-aware address flow:
   - when GeoSearch returns a non-billing parcel BBL, preserve the existing base-context behavior;
   - when GeoSearch returns a condo billing BBL, resolve the base BBL through `CondominiumsClient`;
   - then continue through the existing unit lookup, billing lookup, PLUTO validation, Building Footprints validation, BIN corroboration, and persistence flow.

4. Preserve deterministic explicit failures.
   - zero reverse mappings must fail explicitly;
   - multiple reverse mappings must fail explicitly;
   - do not select an arbitrary record.

# Required regression coverage

Add focused tests proving all of the following:

1. `CondominiumsClient.lookupByCondoBillingBbl(...)` builds a request whose `$where` filters by `condo_billing_bbl`.
2. The reverse lookup correctly classifies one, zero, and multiple matches.
3. A unit-aware address can resolve when GeoSearch supplies billing BBL `1000157502`, the authoritative reverse mapping supplies base BBL `1000150019`, and unit `12C` maps to unit BBL `1000151137`.
4. The unit lookup is called with `1000150019` and never with the arithmetic artifact `1000150002`.
5. Existing direct unit-BBL resolution and existing non-condo/address behavior remain green.
6. Zero/multiple reverse mappings fail instead of guessing.

# Out of scope

Do not:

- hard-code 20 West Street or any of the evidence BBL/BIN values in production code;
- replace the acceptance fixture;
- modify `seed/acceptance-properties.json`;
- modify README/documentation in this task;
- modify ingestion, ECB lifecycle, database schema, migrations, or evidence;
- weaken GeoSearch ambiguity handling, PLUTO validation, Building Footprints validation, or BIN corroboration;
- redesign condo identity or bulk registration unless required by a compile-time interface consequence of this exact reverse lookup.

# Invariants

- Source identifiers remain validated and canonicalized.
- Genuine ambiguity remains an explicit failure.
- No external source result is silently guessed.
- Existing property identity and coverage invalidation rules are unchanged.
- The fix is source-driven and general, not fixture-driven.

# Acceptance criteria

1. The arithmetic billing-lot-to-base-lot derivation is no longer used by the unit-aware address path.
2. Billing BBLs are mapped to base BBLs through the Condominiums dataset.
3. The regression case routes `1000157502 -> 1000150019 -> unit 12C` in tests without production hard-coding.
4. Zero and multiple reverse mappings fail explicitly.
5. `npm run typecheck` passes.
6. `npm run verify:property-resolution` passes.

# Verification

The YAML verification commands are authoritative. The live `npm run acceptance:small` workflow will be rerun after this repair is integrated; do not modify acceptance evidence to make this task pass.
