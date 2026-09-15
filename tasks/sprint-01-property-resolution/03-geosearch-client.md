---
id: S1-T3
stage: 2
model_class: worker
timeout_minutes: 35
review: true
allow_protected: false
depends_on:
  - S1-T1
allowed_paths:
  - src/clients/geosearch.client.ts
  - tests/unit/clients/geosearch.client.test.ts
context:
  - architecture.resolver
  - architecture.data_access_validation
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/clients/geosearch.client.test.ts
---

# Goal

Implement the dedicated NYC GeoSearch client contract used by single-address resolution, with bounded request behavior and deterministic, inspectable response parsing.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`.

# Scope

Implement `GeoSearchClient` using native `fetch` and the existing config/logging boundaries. It must:

- accept the normalized base address produced by the resolver layer;
- construct the GeoSearch request without modifying Queens house-number punctuation;
- apply the configured request timeout/cancellation pattern used by external clients;
- validate HTTP status and minimally validate the response structure;
- expose candidates with the identifiers/evidence required by later deterministic resolver selection, including BBL/BIN when provided by the source;
- surface empty/ambiguous/malformed upstream results as explicit client/domain errors rather than fabricating an identifier;
- avoid embedding business-level candidate selection in the HTTP client.

Automated tests must mock `fetch`; no live NYC call is part of this task.

# Out of scope

Do not implement:

- property persistence;
- final GeoSearch candidate selection policy inside the resolver;
- PLUTO/footprint/condo lookups;
- retries that belong to a future generic source policy unless already established by S0 infrastructure.

# Invariants

- Business services do not construct GeoSearch HTTP URLs directly.
- The client never silently chooses between genuinely ambiguous property candidates.
- Complete upstream payloads/secrets are not dumped to logs.

# Acceptance criteria

1. A successful mocked response is converted into a typed candidate list containing the downstream identifier evidence.
2. The exact normalized base address is used in request construction, including Queens hyphens.
3. Non-2xx, timeout, malformed JSON/shape, and empty-result cases are represented explicitly.
4. Tests prove no final property-selection guess is made by the client itself.

# Verification

Only mocked-network tests are required here; real-data resolution belongs to S5 acceptance.
