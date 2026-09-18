---
id: S5-T12
stage: 8
model_class: hard_worker
timeout_minutes: 210
review: true
allow_protected: false
depends_on:
  - S5-T3
allowed_paths:
  - package.json
  - src/clients/pluto.client.ts
  - src/services/property-resolver/**
  - tests/unit/clients/pluto.client.test.ts
  - tests/unit/property-resolution/**
  - tests/integration/property-resolution/**
  - tests/api/properties.single.test.ts
  - tests/api/properties.bulk.test.ts
  - tests/fixtures/property-resolution/**
  - scripts/acceptance/scale-10000.mjs
  - scripts/acceptance/validate-scale-evidence.mjs
  - seed/scale-10000-bbls.json
  - evidence/scale-10000/**
context:
  - assignment
  - architecture.resolver
  - architecture.data_access_validation
  - architecture.ingestion_strategy
  - architecture.operations
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/clients/pluto.client.test.ts tests/unit/property-resolution/footprint-validation.test.ts
  - npm run verify:property-resolution
  - npm run acceptance:scale:validate-evidence
---

# Goal

Correct the resolver failure semantics and the final 10,000-property scale methodology after S5-T3 exposed real NYC source edge cases.

S5-T3 is historical DONE work. Do not reopen, reset or rewrite that task. This task supersedes only its final scale evidence by producing corrected evidence under the assignment's actual partial-failure contract.

# Required context

Read the listed authoritative contexts plus `AGENTS.md`, the integrated S5-T3 evidence and runner, and only the resolver/client implementation needed for the changes below.

The assignment is the highest source of truth:

- the 10,000-property run is seeded by BBL straight from PLUTO;
- partial failures are recorded, not hidden;
- the run log reports failures;
- a resolved property contains the required canonical property fields, including normalized address.

# Scope

This task has three coupled responsibilities.

## 1. Distinguish absent PLUTO data from unusable PLUTO data

The current PLUTO client treats a raw PLUTO row that exists but cannot form a complete resolver parcel as if no row existed.

Correct that behavior.

At minimum:

- a BBL with no source row remains a genuine PLUTO-not-found result;
- a raw PLUTO row that exists but lacks resolver-required attributes is represented distinctly;
- missing address must not produce the false statement that PLUTO did not contain the parcel;
- surface a distinct resolver error, such as `RESOLVER_PLUTO_INCOMPLETE`, with auditable per-BBL detail describing why the row is unusable;
- cover both single-BBL and bounded bulk PLUTO lookup paths;
- an incomplete parcel remains a resolution failure and must not be persisted as a fully resolved property merely to improve scale success counts.

Keep this refinement narrow. Do not change canonical BBL identity, condo resolution, BIN-set mutation, identifier versioning, or coverage publication semantics.

## 2. Preserve Building Footprints correctness behavior

Do not weaken existing identifier cross-checks.

The following states remain distinct:

```text
no footprint / no valid BIN
    -> property may have no effective BIN
    -> NOT_CHECKED / NO_VALID_BIN where the existing resolver contract allows it

identifier contradiction
    -> explicit resolver failure
    -> never silently guess a BIN or reinterpret the conflict as "no BIN"
```

Add focused regression coverage that proves this distinction remains intact.

## 3. Produce corrected 10,000-property evidence

Replace the resolver-success-prefiltered benchmark methodology with one faithful to the assignment.

The scale runner must:

1. select exactly 10,000 deterministic, unique canonical BBL inputs directly from live PLUTO;
2. use PLUTO-only parcel/BBL validity needed to establish those inputs;
3. keep the chosen community district set and deterministic order explicit in seed provenance;
4. not query Building Footprints or any downstream resolver source to decide which BBLs are allowed into the 10,000-input seed;
5. not filter or replace inputs merely because the application resolver would fail them;
6. submit all 10,000 seed BBLs through the real bounded bulk-registration path;
7. preserve every per-BBL success/failure outcome and exact structured error code/message;
8. enforce exact accounting:

```text
requested = 10,000
accepted + failed = 10,000
```

9. allow a nonzero resolver failure count as valid measured evidence when failures are explicit, unique, attributable and preserved;
10. run ECB ingestion against the actually persisted accepted-property watchlist;
11. require the ingestion run itself to reach its accepted terminal state;
12. commit the regenerated seed, logs, database evidence and summary from that exact run.

A resolver failure discovered during bulk registration is evidence, not automatically a benchmark failure.

An infrastructure failure, unbounded call shape, hidden failure, accounting mismatch, or non-accepted ECB ingestion terminal state still fails the task.

# Scale validator requirements

`npm run acceptance:scale:validate-evidence` remains validation-only and must not make live NYC requests.

Remove any requirement that bulk registration have zero failures.

Instead validate at least:

- exactly 10,000 requested unique seed BBLs;
- accepted + failed = exactly 10,000;
- every failed BBL is unique and belongs to the committed seed;
- every failure has structured error details;
- summary failure counts by code equal the preserved failure entries;
- database property count equals accepted registration count;
- the ingestion watchlist/database evidence is derived from the persisted accepted properties;
- the ECB ingestion run reached the required accepted terminal status;
- measured call/row/batch metrics reconcile with the persisted evidence.

Do not hard-code the identities or count of live resolver failures from an earlier run. NYC source data can change.

# Required tests

Add focused automated coverage for:

1. PLUTO row genuinely absent:
   - remains not-found;
   - surfaces `RESOLVER_PLUTO_NOT_FOUND`.

2. PLUTO row present but incomplete, including missing address:
   - is not classified as absent;
   - surfaces the distinct incomplete/unusable error with reason detail;
   - is not persisted as a fully resolved property.

3. Both single and bulk PLUTO lookup behavior.

4. Building Footprints:
   - absent/no-valid-BIN behavior remains distinct from identifier contradiction;
   - `MAPPLUTO_BBL` / `BASE_BBL` contradictions still fail explicitly.

5. Scale evidence:
   - validator accepts internally consistent evidence with measured resolver failures;
   - validator rejects accepted/failed totals that do not reconcile to 10,000;
   - validator rejects missing/duplicate/unstructured failure detail.

# Out of scope

Do not:

- change the assignment;
- change `ARCHITECTURE.md` or generated architecture modules;
- reopen or modify the historical S5-T3 task;
- add another NYC resolver source merely to eliminate the observed failures;
- persist address-less PLUTO rows as fully resolved properties;
- weaken footprint identifier agreement;
- modify condo semantics;
- modify property BIN mutation/versioning;
- redesign ingestion/publication;
- run multiple community-district samples until a favorable failure count appears;
- make the scale validator query live NYC data;
- hide, replace or silently exclude failed BBLs.

# Invariants

- Nonzero bulk resolver failures are an acceptable scale result when fully accounted for.
- Zero failures are not a goal and must not be manufactured by seed filtering.
- The exact failure set may change as NYC source data changes.
- Seed selection is deterministic and PLUTO-only.
- Every one of the 10,000 requested BBLs has exactly one recorded terminal registration outcome.
- Building Footprints conflicts remain explicit failures.
- No-valid-BIN remains semantically different from an identifier conflict.
- The benchmark uses the application's real bounded bulk path.
- The live 10k benchmark is executed once by implementation; verification/review uses committed evidence only.

# Acceptance criteria

1. The PLUTO client distinguishes absent source rows from present-but-incomplete rows in both single and bulk lookup paths.
2. Resolver/API failure reporting for an incomplete PLUTO parcel is truthful, structured and distinct from `RESOLVER_PLUTO_NOT_FOUND`.
3. Address-less incomplete parcels are not persisted as successfully resolved properties.
4. Existing Building Footprints contradiction semantics remain unchanged and are regression-tested.
5. The committed seed contains exactly 10,000 deterministic unique BBLs selected without Building Footprints/downstream success pre-screening.
6. All 10,000 BBLs pass through the real bulk-registration path and `accepted + failed = 10,000`.
7. Every measured resolver failure is preserved with exact per-BBL error details.
8. The ECB pipeline runs against the persisted accepted watchlist and reaches an accepted terminal state.
9. Corrected machine-readable evidence and raw logs are committed under `evidence/scale-10000/`.
10. `npm run acceptance:scale:validate-evidence` validates the corrected evidence offline.
11. Existing property-resolution verification still passes.
12. No unrelated S0-S4 behavior is changed.

# Verification

The implementation task performs one corrected live 10k benchmark after the resolver and runner corrections are complete.

Harness verification and independent review must not rerun the live benchmark. They validate tests plus the committed scale evidence.
