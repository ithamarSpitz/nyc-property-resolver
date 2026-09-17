---
id: S5-T6
stage: 2
model_class: hard_worker
timeout_minutes: 90
review: true
allow_protected: false
depends_on:
  - S5-T1
allowed_paths:
  - src/services/property-resolver/**
  - src/clients/geosearch.client.ts
  - tests/integration/property-resolution/**
  - tests/unit/clients/geosearch.client.test.ts
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

Repair the address-resolution defect exposed by the S5-T2 live acceptance run:
the required reference property `350 5th Avenue, Manhattan, NY` failed with
HTTP 422 `RESOLVER_GEOSEARCH_AMBIGUOUS`.

This is a focused repair of the existing property-resolution contract, not a
redesign and not an acceptance-fixture workaround.

# Proven failure

The live S5-T2 run reached the public `POST /properties` endpoint and failed on
the first required fixture:

```text
address: 350 5th Avenue, Manhattan, NY
HTTP: 422
code: RESOLVER_GEOSEARCH_AMBIGUOUS
message: GeoSearch returned multiple conflicting parcel candidates for the base address
```

# Scope

Inspect the actual candidate-selection behavior and implement the smallest
general correction that allows an unambiguous best-supported parcel to proceed.

The repair must:
1. remain deterministic;
2. never hard-code Empire State Building, its address, BBL, BIN, coordinates,
   source ID, or any fixture-specific exception;
3. retain genuine ambiguity protection;
4. retain PLUTO and Building Footprints identifier validation;
5. retain GeoSearch BIN corroboration where currently required;
6. preserve condo-unit behavior;
7. add regression coverage for the multi-candidate shape that exposed this defect;
8. preserve an explicit failure when candidates remain genuinely ambiguous.

A valid repair may use candidate ranking/evidence already available to the
resolver and downstream parcel/building corroboration where needed.
Do not implement "always take the first candidate".

# Out of scope

Do not weaken identifier validation, hard-code a BBL, bypass the public
resolver path, modify ingestion behavior, modify S5 evidence, redesign property
identity/condo mapping, or alter assignment/architecture documents.

# Acceptance criteria

1. A multi-BBL result can resolve when one candidate is uniquely justified.
2. Genuine unresolved ambiguity still throws `RESOLVER_GEOSEARCH_AMBIGUOUS`.
3. Existing property-resolution behavior tests remain green.
4. No fixture-specific special case is present.
5. PLUTO / Building Footprints validation still runs after candidate selection.
6. S5-T2 provides the real-network proof for `350 5th Avenue, Manhattan, NY`.
