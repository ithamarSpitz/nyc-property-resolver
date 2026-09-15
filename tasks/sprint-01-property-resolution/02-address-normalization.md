---
id: S1-T2
stage: 2
model_class: worker
timeout_minutes: 35
review: true
allow_protected: false
depends_on:
  - S1-T1
allowed_paths:
  - src/services/property-resolver/address-normalizer.ts
  - tests/unit/property-resolution/address-normalizer.test.ts
context:
  - architecture.resolver
  - architecture.testing
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/property-resolution/address-normalizer.test.ts
---

# Goal

Implement conservative, deterministic address normalization and unit-designator extraction for resolver input identity without corrupting NYC-specific address syntax.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`.

# Scope

Implement a pure address-normalization module that:

- normalizes casing/repeated whitespace deterministically;
- preserves punctuation that is part of NYC address identity;
- preserves Queens hyphenated house numbers exactly, including the `37-15` form;
- recognizes supported unit designators and separates:
  - normalized base address;
  - normalized unit designation;
  - normalized full input identity used for `property_resolution_inputs`;
- keeps two different apartment/unit inputs in the same building distinct;
- returns explicit structured output suitable for later GeoSearch/resolver orchestration.

Keep this module pure and independently testable; it must not perform network or database calls.

# Out of scope

Do not implement:

- GeoSearch candidate selection;
- condo dataset lookup;
- BBL/BIN persistence;
- resolver orchestration;
- arbitrary fuzzy-address correction or guessing.

# Invariants

- `37-15` remains `37-15`; it is never rewritten as `3715`, `37 15`, or a numeric range.
- Normalization is deterministic/idempotent.
- A unit-aware input preserves a stable full normalized-input key while exposing the base address for GeoSearch.
- Different units in the same building do not collapse to the same normalized input.

# Acceptance criteria

1. Repeated whitespace/casing variants normalize to the same deterministic representation.
2. Queens hyphenated house numbers remain byte-for-byte hyphenated in the normalized house-number portion.
3. `419 E 84 St Apt 12C` yields a base-address representation plus unit `12C` and a distinct full normalized input.
4. Equivalent supported unit syntax normalizes consistently without dropping the unit.
5. Running normalization twice produces the same result as running it once.
6. The test suite covers normal address, Queens hyphen, unit-aware address, and malformed/empty input behavior.

# Verification

The Harness reruns the focused test and typecheck after the agent finishes.
