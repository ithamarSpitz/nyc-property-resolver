---
id: S1-T4
stage: 2
model_class: worker
timeout_minutes: 35
review: true
allow_protected: false
depends_on:
  - S1-T1
allowed_paths:
  - src/clients/pluto.client.ts
  - tests/unit/clients/pluto.client.test.ts
context:
  - architecture.resolver
  - architecture.data_access_validation
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/clients/pluto.client.test.ts
---

# Goal

Implement the PLUTO client boundary for deterministic parcel lookup by canonical BBL, leaving resolver/business decisions outside the HTTP client.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`.

# Scope

Implement `PlutoClient` using native `fetch` that:

- queries PLUTO using canonical BBL input;
- selects/parses the parcel attributes needed by property resolution and persistence;
- preserves source identifier strings safely rather than applying lossy numeric conversion;
- applies HTTP status/timeout/minimal-structure validation;
- returns typed zero/one/multiple-result information so the resolver can make explicit deterministic decisions;
- keeps request construction inside the client.

Tests mock `fetch` and cover request construction, identifier parsing, empty result, duplicate/ambiguous result, malformed response, timeout, and non-2xx behavior.

# Out of scope

Do not implement:

- resolver orchestration;
- condo mapping;
- Building Footprints validation;
- bulk 10k registration methods yet (those belong to the dedicated bulk task in Stage 4).

# Invariants

- Canonical BBL identity is treated as a string contract, not a number that may lose padding.
- Empty source results are explicit; they are not converted into guessed parcel data.
- Business services do not construct PLUTO URLs directly.

# Acceptance criteria

1. Canonical BBL lookup produces the expected bounded PLUTO request.
2. Required parcel identifiers/attributes are parsed without losing zero padding.
3. Empty, malformed, non-2xx, timeout, and unexpected multiple-result cases are explicit and tested.
4. The client has no dependency on GeoSearch or property persistence.

# Verification

The focused mocked-client suite and typecheck must pass.
