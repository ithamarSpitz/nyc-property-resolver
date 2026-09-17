---
id: S5-T8
stage: 4
model_class: hard_worker
timeout_minutes: 75
review: true
allow_protected: false
depends_on:
  - S5-T2
allowed_paths:
  - src/clients/building-footprints.client.ts
  - tests/unit/clients/building-footprints.client.test.ts
  - src/clients/socrata.client.ts
  - tests/unit/clients/socrata.client.test.ts
context:
  - architecture.resolver
  - architecture.data_access_validation
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/clients/building-footprints.client.test.ts tests/unit/clients/socrata.client.test.ts
---

# Goal

Repair the two live NYC Open Data contract defects proven by S5-T3 before
rerunning the 10,000-property scale acceptance.

This is a focused compatibility repair of existing source clients. It does not
change property identity semantics, watchlist strategy, ingestion lifecycle, or
the S5 scale evidence contract.

# Proven failures

## Building Footprints

Dataset `5zhs-2jue` currently exposes the MapPLUTO corroboration field as
`mappluto_bbl`.

The integrated client still selects, parses and filters `mpluto_bbl`. S5-T3
reproduced the failure with the exact production query shape:

- the 200-BBL query using `mpluto_bbl` returned HTTP 400
  `query.soql.no-such-column`;
- the otherwise-identical query using `mappluto_bbl` returned HTTP 200;
- a 2-BBL request through the running `/properties/bulk` API reproduced the
  same `BUILDING_FOOTPRINTS_HTTP_ERROR`.

The logical resolver rule remains unchanged: MapPLUTO BBL is preferred
corroboration when present, with BASE_BBL fallback under the existing rules.

## ECB Socrata page selection

Dataset `6bgk-3dad` currently rejects:

```text
$select=:id,:updated_at,*
```

with HTTP 400:

```text
Star selections must come at the start of the select-list
```

The equivalent live request succeeds with:

```text
$select=*,:id,:updated_at
```

The architecture source of truth was corrected by CR-0007 to require the
star-first form while still explicitly requesting both Socrata system fields.

# Scope

## Building Footprints client

Update only the physical upstream field spelling required by the live dataset:

```text
mpluto_bbl -> mappluto_bbl
```

Apply it consistently to:

- the select list;
- single-BBL where construction;
- bulk-BBL where construction;
- response parsing / MapPLUTO evidence extraction;
- focused unit-test fixtures and exact query assertions.

Do not rename or weaken the logical `MAPPLUTO_BBL` resolver concept, mismatch
errors, BASE_BBL fallback, canonical BBL validation, or BIN validation.

## Socrata ECB client

Change the ECB data-page select contract to exactly:

```text
*,:id,:updated_at
```

Keep:

- explicit `:id` and `:updated_at` selection;
- stable `$order=:updated_at,:id`;
- immutable BIN batching;
- page size / offset behavior;
- request-executor/retry boundaries;
- row identity/version extraction.

Update the focused unit test so it locks the live-valid star-first select order.

# Out of scope

Do not:

- modify S5-T3 scale runner, seed or evidence;
- change batching/concurrency/retry limits;
- redesign resolver corroboration rules;
- change ingestion persistence, promotion, reconciliation or coverage behavior;
- add fixture-specific exceptions;
- weaken tests to accept both old and new query contracts.

# Acceptance criteria

1. `src/clients/building-footprints.client.ts` no longer queries or parses
   `mpluto_bbl`; it uses the live `mappluto_bbl` field consistently.
2. Existing logical MapPLUTO/BASE_BBL corroboration behavior remains unchanged.
3. ECB data pages use exactly `$select=*,:id,:updated_at`.
4. ECB page ordering remains exactly `$order=:updated_at,:id`.
5. Focused client tests lock both repaired live query contracts.
6. Typecheck and both focused client suites pass.
7. S5-T3 remains the real-network proof that the repaired clients work at the
   required 10,000-property scale.

# Verification note

Deterministic tests are authoritative for this corrective task. Small bounded
live probes may be used during implementation for diagnosis, but the next
S5-T3 execution is the required live acceptance proof.
