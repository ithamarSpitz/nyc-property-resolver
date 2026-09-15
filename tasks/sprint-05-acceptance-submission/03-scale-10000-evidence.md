---
id: S5-T3
stage: 3
model_class: hard_worker
timeout_minutes: 180
review: true
allow_protected: false
depends_on:
  - S5-T2
allowed_paths:
  - package.json
  - seed/scale-10000-bbls.json
  - scripts/acceptance/scale-10000.mjs
  - scripts/acceptance/validate-scale-evidence.mjs
  - evidence/scale-10000/**
context:
  - assignment
  - architecture.ingestion_strategy
  - architecture.operations
  - architecture.testing
environment: docker
verification:
  - npm run acceptance:scale:validate-evidence
---

# Goal

Run the assignment's real 10,000-property scale acceptance through the bounded bulk-registration/watchlist-ingestion design and commit measured, reproducible evidence rather than projected numbers.

# Required context

Read only the listed context aliases plus `AGENTS.md`, S5-T2 evidence, and the integrated S1 bulk/S2–S4 ingestion/runtime contracts.

# Scope

Create one cross-platform scale runner and execute it against a clean, dedicated Compose state.

The runner must:

1. select exactly 10,000 valid unique property BBLs directly from live PLUTO using a deterministic query/order and one or two explicitly recorded community districts;
2. save the selected BBL seed and PLUTO query/provenance so the sample can be reproduced;
3. register the sample through the application's **bulk BBL path**, not 10,000 single-property HTTP/resolver calls;
4. record bulk-registration wall time, accepted/failed property counts and resulting unique valid BIN count;
5. run the real ECB watchlist pipeline against the resulting tracked BIN set;
6. preserve the structured application/worker log for the scale run;
7. derive metrics from actual instrumentation/logs/database state rather than estimates.

The committed summary must include at least:

```text
wall time
unique properties
unique valid BINs
Socrata data-page calls
Socrata metadata calls
Socrata retry calls
Socrata total calls
rows fetched
rows promoted
failures
final run status
```

Also record persisted batch count, configured batch/page/concurrency/retry bounds, start/end source watermarks, and enough arithmetic to make the call shape auditable. The measured 10k result is evidence; 20k extrapolation/strategy discussion belongs in DESIGN.md in S5-T4.

The scale script must include a validation-only mode or separate validator that checks evidence completeness without rerunning the benchmark. Harness verification uses that path.

If the benchmark exposes a correctness defect, unsafe one-call-per-property shape, unbounded behavior, or terminal failure, preserve logs and fail. Do not weaken the benchmark or silently reduce below 10,000 properties to get a green result.

# Out of scope

Do not:

- geocode 10,000 free-text addresses;
- replace the application's bulk path with a direct database insert that bypasses property-registration semantics;
- run multiple community-district samples until one happens to look favorable;
- edit core S0–S4 behavior in this task;
- turn measured failures/retries into undocumented exclusions;
- write final README/DESIGN prose here.

# Invariants

- Exactly 10,000 unique BBLs are the requested scale input.
- Property resolution cost is paid once through bounded bulk source queries; the ingestion scan is BIN-based.
- Every HTTP/retry/page/batch loop remains subject to the existing explicit bounds.
- Metrics are measured from the run that produced the committed logs and identify that exact run.
- Secrets are redacted from saved logs.

# Acceptance criteria

1. `seed/scale-10000-bbls.json` contains exactly 10,000 unique valid BBLs plus deterministic PLUTO provenance metadata.
2. The bulk registration path processes the sample without issuing 10,000 individual resolver/API calls.
3. The ECB run uses the actual persisted watchlist and reaches a recorded terminal status; a non-accepted terminal state causes this task to fail even though its diagnostics are preserved.
4. Every metric required by the assignment and architecture is present and derived from actual run evidence.
5. The raw scale worker log and machine-readable summary are committed under `evidence/scale-10000/`.
6. `npm run acceptance:scale:validate-evidence` passes without re-running live NYC traffic.
7. No scale number is silently estimated when a measured value is available.

# Verification

The live benchmark is executed once by the task. Harness/reviewer verification validates the resulting artifacts and arithmetic rather than spending another full 10k run on every retry/review.
