<!-- GENERATED CONTEXT MODULE. Source of truth: /ARCHITECTURE.md. -->
<!-- Do not edit independently; regenerate from the final architecture if it changes. -->

## 9. Raw and Normalized ECB Storage

Raw and normalized records are stored separately.

### Raw data

The raw table preserves the upstream payload with provenance.

Typical fields:

```text
ecb_violation_raw
-----------------
id
source_id NOT NULL
socrata_row_id NOT NULL
source_row_updated_at NOT NULL
fetched_at
first_seen_run_id NOT NULL
payload JSONB
```

Constraint:

```text
UNIQUE(source_id, source_row_updated_at)
```

Purpose:

- retain the original source fields and values in a semantically equivalent JSON representation
- preserve source provenance
- keep a new raw version only when the upstream source version changes
- avoid duplicate raw rows when the same source version is fetched repeatedly
- allow normalization logic to be corrected later
- allow normalized source-field values to be re-derived from previously fetched raw versions without refetching those source versions

Raw storage does not by itself encode absence. Therefore it is sufficient to rebuild parsed/normalized source-field values after parser/normalization changes, but it is not sufficient to reconstruct current/deleted state solely from positive raw rows.

`is_current` / current-state semantics are established by successful promotion and reconciliation of an accepted watchlist run. `is_current` describes source-current state for a scanned BIN; current portfolio membership is evaluated separately through the live `property_bins` relationships.

### Source row identity

For DOB ECB Violations, the application uses:

```text
source_id = ISN_DOB_BIS_EXTRACT
```

The Socrata system row identifier is retained separately:

```text
socrata_row_id = :id
source_row_updated_at = :updated_at
```

Before the implementation treats `ISN_DOB_BIS_EXTRACT` as the durable business/source key, a source-contract verification test/probe checks:

```text
count(*)
count(distinct ISN_DOB_BIS_EXTRACT)
NULL count
duplicate groups
```

The implementation must not enable production-style ingestion with this key if the verification does not hold; the key choice must then be revisited explicitly rather than silently changing idempotency semantics.

`ECB_VIOLATION_NUMBER` is stored as a domain field but is not used as the primary ingestion identity unless source verification shows the dataset contract requires it.

### Normalized data

The normalized table contains application-ready values.

Typical fields:

```text
ecb_violations
--------------
source_id
socrata_row_id
bin
violation_number
issue_date
ecb_violation_status
balance_due
source_row_updated_at
last_success_run_id
is_current
...
updated_at
```

Dates and numeric values are parsed into proper database types during normalization.

### Staging Promotion and Current-State Reconciliation

`ecb_violation_staging` contains normalized candidates for one run. `ecb_violations` represents the last accepted live state.

A run may promote staging only when:

```text
all required batches completed successfully
AND
the best-effort dataset watermark guard is unchanged
```

Promotion is performed in a short database transaction:

```text
BEGIN

UPSERT staging rows for run R
into live ecb_violations

set:
  last_success_run_id = R
  is_current = true

for every fully scanned BIN:
  live rows not present in staging for run R
  -> is_current = false

update successful property coverage

mark run COMPLETED

COMMIT
```

A failed or `SOURCE_CHANGED` run does not promote staging and does not perform negative reconciliation.

Therefore:

```text
raw
= source versions observed during attempts

staging
= normalized candidate state for one attempt

ecb_violations
= last successfully accepted live state
```

This prevents partially successful runs from exposing a hybrid live state.
## 10. Idempotency

Idempotency is enforced at the database level.

Important unique constraints include:

```text
properties.bbl
```

```text
(property_bins.property_id, property_bins.bin)
```

```text
(ecb_violation_raw.source_id, ecb_violation_raw.source_row_updated_at)
```

```text
(ecb_violation_staging.run_id, ecb_violation_staging.source_id)
```

```text
ecb_violations.source_id
```

```text
(property_dataset_coverage.property_id, property_dataset_coverage.dataset)
```

```text
(ingestion_batches.run_id, ingestion_batches.batch_number)
```

Repeated resolution or ingestion therefore updates or reuses the same logical records instead of creating duplicates.

All columns that participate in logical identity constraints are defined `NOT NULL`. This is required because PostgreSQL unique constraints do not treat multiple `NULL` values as equal by default.

Database `UPSERT` / `ON CONFLICT` behavior is used where appropriate.

The application does not rely only on a read-before-write check for uniqueness.

---
## 11. Coverage and Freshness

An empty violations list is not sufficient to describe data quality.

The system stores explicit coverage state for each property and dataset.

Supported states:

```text
CHECKED
The latest accepted processing attempt established complete, trustworthy
coverage for the property. The property may legitimately have zero ECB violations.

NOT_CHECKED
No accepted ECB processing attempt has yet established coverage for the property.

FAILED
The latest property-scoped processing attempt did not establish complete, trustworthy coverage.
This includes upstream/fetch failures, normalization failures, batch-limit exhaustion,
and SOURCE_CHANGED after a committed property scope exists.
The previous successful coverage metadata, if any, is retained separately.
```

Example API response:

```json
{
  "violations": [],
  "coverage": {
    "status": "checked",
    "lastAttemptAt": "2026-09-15T10:00:00Z",
    "lastSuccessAt": "2026-09-15T10:00:00Z",
    "sourceWatermarkAt": "2026-09-15T09:40:00Z"
  }
}
```

Coverage state is stored independently from the existence of violation rows.

Coverage for run `R` is derived only from `ingestion_run_property_bins` for `R`, never from the live `property_bins` table. This guarantees that properties and BIN associations added during an in-progress run do not retroactively change that run's coverage requirements.

For properties with multiple BINs, coverage is successful only when every valid BIN included in that run's persisted Property<->BIN snapshot has been fetched successfully, the run passed its source-change guard, and the property's current `identifier_version` still matches the version captured in the run snapshot.

```text
Property P
  +-- BIN A -> success
  +-- BIN B -> success
  => CHECKED

Property P
  +-- BIN A -> success
  +-- BIN B -> failed
  => FAILED
```

Coverage stores both the latest attempt and the latest complete success so a failed current scan does not erase knowledge of the last successfully completed scan.

For a `SOURCE_CHANGED` run:

```text
coverage.status = FAILED
last_attempt_run_id = current run
last_error = SOURCE_CHANGED

last_success_run_id
last_success_at
source_watermark_at
```

remain from the previous accepted run.

Because failed/source-changed staging is not promoted, the live ECB rows and `last_success_*` metadata continue to describe the same accepted state.

The source freshness value on successful coverage is the **dataset-level watermark observed for the accepted run**, not a row-level `:updated_at` value. This allows checked-empty properties to carry meaningful source freshness metadata.

Properties that cannot be scanned because no valid building BIN exists remain non-successfully processed (for example `NOT_CHECKED`) with an explicit reason such as `NO_VALID_BIN`; they are never treated as successfully checked with an empty result.

Recommended fields include:

```text
last_attempt_run_id
last_success_run_id
last_attempt_at
last_success_at
source_watermark_at
last_error
```

---
## 12. PostgreSQL Data Model

### `property_resolution_inputs`

```text
id
input_type NOT NULL
normalized_input NOT NULL
property_id NOT NULL
resolved_at NOT NULL
resolver_confidence NULL
resolver_metadata JSONB
```

Constraints:

```text
UNIQUE(input_type, normalized_input)
FOREIGN KEY(property_id) -> properties(id)
```

Examples of `input_type`:

```text
ADDRESS
BBL
```

For address input, `normalized_input` includes the normalized unit designator when one is present.

This table guarantees that once a specific normalized input has been resolved, future calls return the same stored property mapping without re-running GeoSearch.

---

### `properties`

```text
id
identifier_version NOT NULL DEFAULT 1
bbl
condo_base_bbl NULL
condo_billing_bbl NULL
normalized_address
borough
block
lot
created_at
resolved_at
```

Constraints:

```text
UNIQUE(bbl)
```

---

### `property_bins`

Contains only valid, non-placeholder BINs.

```text
property_id
bin
```

Constraints:

```text
UNIQUE(property_id, bin)
INDEX(bin)
```

`property_bins` is not mutated directly. Effective BIN-set changes must go through the
transactional identifier-update operation described in §5.4 so `identifier_version` and
coverage remain consistent.

---

### `ecb_violation_raw`

```text
id
source_id
socrata_row_id
source_row_updated_at NOT NULL
fetched_at
first_seen_run_id
payload JSONB
```

Constraints:

```text
UNIQUE(source_id, source_row_updated_at)
```

Stores the original source fields and values plus provenance. JSONB preserves the semantic JSON payload, not byte-for-byte formatting.

---

### `ecb_violation_staging`

```text
run_id
source_id
socrata_row_id
bin
violation_number
issue_date
ecb_violation_status
balance_due
source_row_updated_at
...
```

Constraints:

```text
UNIQUE(run_id, source_id)
INDEX(run_id, bin)
```

Contains normalized candidate rows produced by one ingestion attempt.

Staging rows are not served by the API. They are promoted into `ecb_violations` only after the run is accepted.

---

### `ecb_violations`

```text
source_id
socrata_row_id
bin
violation_number
issue_date
ecb_violation_status
balance_due
source_row_updated_at
last_success_run_id NOT NULL
is_current
...
updated_at
```

Constraints:

```text
UNIQUE(source_id)
INDEX(bin)
```

Additional indexes are added only for query patterns used by the API, such as newest-first lookup and unpaid violations.

---

### `ingestion_runs`

```text
id
dataset
status
trigger_type
initialization_complete NOT NULL DEFAULT false
expected_property_bin_count NULL
expected_bin_count NULL
expected_batch_count NULL
failure_stage NULL
last_error NULL
started_at
finished_at
source_watermark_at_start NULL
source_watermark_at_end NULL
bins_scanned
data_page_calls
metadata_calls
retry_calls
total_socrata_calls
rows_fetched
rows_written
failures
```

Constraints:

```text
At most one run per `dataset` may have status IN ('queued', 'running')
```

Implemented as a PostgreSQL partial unique index on `ingestion_runs(dataset)` for active statuses.

For this data point:

```text
dataset = DOB_ECB_VIOLATIONS
```

The same dataset identifier is used to derive the advisory-lock key and to key coverage records.

This constraint prevents multiple active run records. A PostgreSQL advisory lock separately prevents multiple processes from executing the active run concurrently.

State constraint:

```text
RUNNING/COMPLETED/SOURCE_CHANGED
require source_watermark_at_start IS NOT NULL
```

`QUEUED` and initialization-time `FAILED` runs may have a null start watermark.

Represents one complete ECB synchronization attempt.

---

### `ingestion_run_property_bins`

```text
run_id NOT NULL
property_id NOT NULL
property_identifier_version NOT NULL
bin NOT NULL
```

Constraints:

```text
PRIMARY KEY(run_id, property_id, bin)
INDEX(run_id, bin)
INDEX(run_id, property_id)
```

This table is the immutable Property<->BIN snapshot for one ingestion run.

It is populated exactly once for a new run from the valid current `property_bins` relationships.

All run semantics derive from this snapshot:

```text
batching
= DISTINCT bin from ingestion_run_property_bins for run R

failure attribution
= properties linked to failed BINs in run R

coverage
= BIN requirements for each property from run R's snapshot
  plus the snapshotted property_identifier_version
```

A resumed run never rebuilds this table from current `property_bins`.

If a property or BIN association changes while a run is in progress, that change belongs to the next run.

---

### `ingestion_batches`

```text
id
run_id
batch_number
status
batch_definition NOT NULL
pages_fetched
attempt_count
rows_fetched
last_error
completed_at
```

Constraints:

```text
UNIQUE(run_id, batch_number)
```

Represents resumable BIN-batch progress within a run. `batch_definition` is immutable after batch creation. A partial batch restarts from its first Socrata page rather than resuming from a persisted OFFSET.

---

### `property_dataset_coverage`

```text
property_id
dataset
status
status_reason NULL
last_attempt_run_id
last_success_run_id
last_attempt_at
last_success_at
source_watermark_at
last_error
```

Constraints:

```text
UNIQUE(property_id, dataset)
```

Represents freshness and processing coverage independently from result rows. `CHECKED` is written only when every valid BIN associated with the property in that run's immutable Property<->BIN snapshot completed successfully for that ingestion run.

---





### Run-Level Failure vs Property-Level Coverage

A run can fail before it has a committed property scope.

If failure occurs before the initialization transaction commits
`ingestion_run_property_bins`, there is no authoritative set of properties to which that
failure can be attributed.

Therefore:

```text
failure before committed run property scope
-> ingestion_run = FAILED
-> property_dataset_coverage is NOT mutated
-> failure is exposed as dataset/run operational metadata

failure after committed run property scope exists
-> ingestion_run = FAILED / SOURCE_CHANGED
-> property-level attempt coverage may be updated for properties in that snapshot
```

This distinction preserves the meaning of property coverage:

```text
NOT_CHECKED
= this property has not yet had a complete property-scoped attempt

FAILED
= a property-scoped attempt that included this property failed
```

The API exposes the latest dataset-run operational state separately from property coverage,
for example:

```json
{
  "coverage": {
    "status": "not_checked",
    "statusReason": "never_ingested"
  },
  "datasetRun": {
    "status": "failed",
    "failureStage": "initialization",
    "failedAt": "2026-09-15T10:00:00Z"
  }
}
```

A pre-scope initialization outage is therefore visible without falsely claiming that every
property was individually attempted and failed.

### Coverage Initialization During Property Registration

Coverage is explicit persisted state; absence of a coverage row is not used to mean `NOT_CHECKED`.

When a new property is first registered:

```text
if valid BIN count > 0:
  INSERT property_dataset_coverage if absent:
    dataset = DOB_ECB_VIOLATIONS
    status = NOT_CHECKED
    status_reason = NEVER_INGESTED

if valid BIN count = 0:
  INSERT/UPSERT property_dataset_coverage:
    dataset = DOB_ECB_VIOLATIONS
    status = NOT_CHECKED
    status_reason = NO_VALID_BIN
```

Adding another input alias that resolves to the same existing property does not reset coverage.

Only a real change to the effective valid BIN set invalidates previous coverage, through the identifier-version rule above.

### Properties With No Valid BIN

A property with zero valid BINs is not represented in `ingestion_run_property_bins`, because there is nothing that can be fetched from the ECB source for that property.

Therefore `NO_VALID_BIN` coverage is written by the property registration/resolution path, not by the ECB ingestion run. This is the zero-BIN branch of the general coverage-initialization rule above.

After BIN filtering:

```text
zero valid BINs
   |
   v
UPSERT property_dataset_coverage:
  dataset = DOB_ECB_VIOLATIONS
  status = NOT_CHECKED
  status_reason = NO_VALID_BIN
  last_attempt_run_id = NULL
  last_attempt_at = NULL
```

`NO_VALID_BIN` is a coverage reason, not a fetch error.

If the property is later re-resolved and gains a valid BIN, the registration path clears `NO_VALID_BIN`; the next ingestion run will include the property in its immutable Property<->BIN snapshot.

This guarantees that the API never represents "could not be scanned because no valid BIN exists" as `CHECKED` with an empty result.

### Failed Attempt Coverage Updates

A terminal `FAILED` or `SOURCE_CHANGED` run does not promote staging. If the run has a committed Property<->BIN snapshot, it updates attempt metadata in `property_dataset_coverage`. The run transition and any eligible coverage updates are committed atomically in one database transaction.

If the run failed before the Property<->BIN initialization transaction committed, there is no property-level coverage update; only the run/dataset-level failure is published.

For each property included in the run snapshot, failure coverage is published only when
the property's current `identifier_version` still equals the snapshotted
`property_identifier_version`.

```text
if current identifier_version == snapshot identifier_version:
    status = FAILED
    last_attempt_run_id = current run
    last_attempt_at = run finish time

if current identifier_version != snapshot identifier_version:
    do not mutate current property coverage
```

The previous successful fields remain unchanged:

```text
last_success_run_id
last_success_at
source_watermark_at
```

Failure reason is attributed using the run snapshot.

For properties whose required BIN is directly associated with a failed batch:

```text
last_error = concrete batch/source/normalization error
```

For properties whose own BIN work succeeded but the run as a whole was not accepted:

```text
last_error = RUN_NOT_PROMOTED
```

For a source watermark change:

```text
last_error = SOURCE_CHANGED
```

Thus:

```text
Run A -> COMPLETED
live state = A
coverage.last_success_run_id = A

Run B -> FAILED / SOURCE_CHANGED
live state remains A
coverage.status = FAILED
coverage.last_attempt_run_id = B
coverage.last_success_run_id = A
```

This keeps live data and last-success metadata aligned while still making the latest failed attempt visible to callers.



### Atomic Terminal Failure Publication

Terminalizing a run and publishing its failed attempt coverage are one database transaction.

```text
BEGIN

UPDATE ingestion_runs
SET status = FAILED or SOURCE_CHANGED,
    finished_at = ...,
    failure_stage = ...,
    last_error = ...

IF a committed run Property<->BIN snapshot exists:

  UPDATE property_dataset_coverage
  for properties in this run's immutable snapshot
  whose current identifier_version still matches the snapshot version:
    status = FAILED
    last_attempt_run_id = current run
    last_attempt_at = run finish time
    status_reason / last_error = appropriate failure reason

ELSE:
  no property-level coverage mutation

COMMIT
```

This prevents crash windows where:

```text
run = FAILED but coverage still says CHECKED
```

or:

```text
coverage = FAILED but run still says RUNNING
```

`last_success_*` remains unchanged in the same transaction.
