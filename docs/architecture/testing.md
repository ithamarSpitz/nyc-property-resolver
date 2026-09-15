<!-- GENERATED CONTEXT MODULE. Source of truth: /ARCHITECTURE.md. -->
<!-- Do not edit independently; regenerate from the final architecture if it changes. -->

## 23. Testing Strategy

The test suite focuses on behavior that affects correctness.

### Jest

Used for service and ingestion behavior.

Core tests include:

- address normalization
- Queens hyphenated house number preservation (`37-15` remains `37-15`)
- normalized-input resolver idempotency
- same address input returns the same stored property without a second external resolution
- condo-unit address resolution by unit designator
- ambiguous/unmatched condo-unit address fails explicitly
- property resolver idempotency
- GeoSearch BIN vs validated footprint BIN conflict fails explicitly
- non-condo footprint mapping accepts matching MAPPLUTO_BBL/canonical PLUTO BBL
- non-condo footprint MAPPLUTO_BBL mismatch fails explicitly
- zero-valid-BIN property persists NOT_CHECKED / NO_VALID_BIN coverage
- new property with valid BIN initializes NOT_CHECKED / NEVER_INGESTED coverage
- ECB normalization
- repeated ingestion upsert behavior
- run resume behavior
- losing the advisory-lock client aborts ingestion even while Prisma remains usable
- terminal FAILED run updates attempt coverage without changing last_success
- terminal FAILED/SOURCE_CHANGED run transition and failed coverage commit atomically
- coverage is derived from the run snapshot, not live property_bins
- run Property<->BIN snapshot is immutable across resume
- initialization metadata failure creates durable FAILED run
- crash after watermark fetch but before persistence leaves QUEUED + NULL and retries safely
- crash during batch creation leaves no partial initialized batch set
- crash during Property<->BIN snapshot leaves no partial initialized snapshot
- resume uses persisted immutable batch definitions even if the watchlist changes
- batch attempt exhaustion becomes terminal `FAILED`
- coverage state transitions
- BIN-set mutation, identifier_version increment, and coverage invalidation commit atomically
- failed old run cannot overwrite coverage after identifier_version changes
- pre-scope initialization failure is visible as run-level failure without mutating property coverage
- adding an alias without changing BIN set does not invalidate coverage
- BIN-set change immediately invalidates previous CHECKED coverage
- successful run does not mark CHECKED when identifier_version changed after snapshot
- portfolio ECB endpoint excludes is_current=false rows by default
- portfolio ECB endpoint excludes rows whose BIN is no longer in current property_bins
- staging promotion on a successful run
- `SOURCE_CHANGED` rejection behavior

### Supertest

Used for HTTP behavior.

Core API tests include:

- property creation
- duplicate property creation
- query parameter validation
- unpaid ECB filtering
- `openOnly=true` returns only `ACTIVE` violations
- property ECB results are sorted newest first
- `issue_date IS NULL` rows sort after dated rows
- cursor pagination preserves exact newest-first ordering
- pagination crosses correctly from the last dated row to the first `issue_date IS NULL` row
- pagination continues across multiple pages inside the `issue_date IS NULL` tail
- pagination
- checked-empty coverage
- not-checked coverage
- failed-fetch coverage

A dedicated Property<->BIN snapshot coverage test verifies:

```text
Run R snapshot:
  property P -> BIN A

while R is running:
  live property_bins changes to:
  property P -> BIN A, BIN B

Run R:
  still requires only BIN A for P
  coverage is computed from R's snapshot
  BIN B is picked up by the next run
```

A dedicated immutable-batch resume test verifies:

```text
Run R snapshot:
  tracked BINs = [A, B, C, D]
  batch 1 = [A, B]
  batch 2 = [C, D]

batch 1 completes
worker stops

AA is added to the watchlist while the worker is down

resume R:
  batch 1 remains [A, B]
  batch 2 remains [C, D]
  no repartition occurs
  AA is not processed in R
  AA is included in the next run
```

A dedicated `SOURCE_CHANGED` behavior test verifies:

```text
Run A is promoted successfully
live state = A

Run B:
  start watermark = X
  candidate rows written to staging
  end watermark = Y
  X != Y

assert:
  run B -> SOURCE_CHANGED
  run B staging is not promoted
  live state remains exactly Run A
  no negative reconciliation runs
  coverage.status = FAILED
  coverage.last_attempt_run_id = B
  coverage.last_success_run_id = A
  next execution starts all batches again
```

External NYC APIs are mocked in automated tests so test results do not depend on network availability.

---
## 24. Acceptance Verification

Automated tests are supplemented with a small real-data acceptance suite.

### Seed acceptance set

The repository includes 5–8 real NYC properties covering:

```text
- 350 5th Avenue, Manhattan
- one Queens address with a hyphenated house number (37-15 form), verifying that normalization preserves the hyphen
- one condominium unit
- one small 2–3 family property
- at least one property with an unpaid ECB balance
```

### Manual verification

The acceptance walkthrough includes:

```text
1. Resolve the small seed set.
2. Run ECB ingestion.
3. Spot-check at least two properties against the BIS Property Profile.
4. Record in README whether local counts/statuses match BIS.
5. Run the same ingestion again.
6. Verify the second run does not create duplicate logical rows.
7. Save the baseline run log and idempotent second-run log.
```

### Scale verification

The 10,000-property run uses BBLs seeded directly from PLUTO through the bulk BBL registration path.

The recorded summary includes:

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

---
