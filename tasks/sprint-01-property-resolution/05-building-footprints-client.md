---
id: S1-T5
stage: 2
model_class: worker
timeout_minutes: 35
review: true
allow_protected: false
depends_on:
  - S1-T1
allowed_paths:
  - src/clients/building-footprints.client.ts
  - tests/unit/clients/building-footprints.client.test.ts
context:
  - architecture.resolver
  - architecture.data_access_validation
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/clients/building-footprints.client.test.ts
---

# Goal

Implement the Building Footprints source client that returns the identifier evidence required for BIN discovery and later parcel cross-checking.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`.

# Scope

Implement `BuildingFootprintsClient` using native `fetch` with lookup support required by S1 resolution, including the architecture-defined parcel fields:

- BIN;
- `BASE_BBL`;
- `MAPPLUTO_BBL` when present.

The client must:

- query by the parcel/base identifiers needed by normal and condo resolution;
- retain multiple footprint candidates where a parcel legitimately has multiple buildings;
- apply timeout, HTTP status, and minimal response validation;
- return typed candidate evidence without deciding which candidates are semantically valid for the canonical parcel.

Tests use mocked `fetch` and include multi-BIN lots, missing optional `MAPPLUTO_BBL`, malformed identifiers, empty results, timeout, and non-2xx behavior.

# Out of scope

Do not implement:

- the `MAPPLUTO_BBL`/`BASE_BBL` acceptance rule itself;
- GeoSearch BIN contradiction handling;
- placeholder-BIN filtering/persistence;
- bulk query methods for the 10k path yet.

# Invariants

- A lot may return more than one building/BIN and the client must preserve that fact.
- The client preserves both `MAPPLUTO_BBL` and `BASE_BBL` evidence for the resolver to cross-check.
- No arbitrary footprint candidate is silently selected by the HTTP client.

# Acceptance criteria

1. Mocked parcel lookup returns all relevant footprint/BIN candidates.
2. `MAPPLUTO_BBL` and `BASE_BBL` are preserved independently.
3. Missing optional `MAPPLUTO_BBL` remains distinguishable from a conflicting value.
4. Empty/malformed/non-2xx/timeout behavior is explicit and tested.

# Verification

The focused mocked-client suite and typecheck must pass.
