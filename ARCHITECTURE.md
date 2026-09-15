# NYC Property Resolver + ECB Violations
## Architecture and Technical Design

## 1. Overview

This service resolves NYC properties into stable NYC identifiers, periodically ingests DOB ECB Violations for the tracked property watchlist, stores both raw and normalized data locally, and exposes the stored data through an HTTP API.

The system is designed around five core principles:

1. **Resolve once, scan by identifiers**  
   Property addresses are resolved once and persisted with their BBL and BIN identifiers. Recurring scans use the stored identifiers and do not geocode properties again.

2. **Serve monitored-data queries from the local database**  
   Property registration is a one-time resolution operation and may call NYC resolution sources. Once a property is resolved, stored-property and ECB query endpoints are served entirely from the local database and never depend on NYC APIs at request time.

3. **Use watchlist-based ingestion**  
   ECB data is fetched only for BINs belonging to tracked properties. BINs are deduplicated and fetched in batches.

4. **Promote only successful normalized state**  
   Raw payloads are persisted immediately, but normalized candidates are written to run-scoped staging. The live normalized table is updated only after the run is accepted.

5. **Persist operational state**  
   Ingestion progress, failures, freshness, and coverage are stored in PostgreSQL so runs can be resumed safely and API consumers can distinguish between successful empty results, unprocessed properties, and failed fetches.

---

## 2. Technology Stack

| Layer | Technology | Responsibility |
|---|---|---|
| Runtime | Node.js 22 | Runs the API and ingestion worker |
| Language | TypeScript | Application code and type safety |
| HTTP API | Express | REST API and HTTP middleware |
| Validation | Zod | Runtime validation of API input and external data |
| Database | PostgreSQL | Persistent source of truth |
| Database access | Prisma | Data access, schema models, migrations |
| Lock ownership | `pg` (node-postgres) | Dedicated PostgreSQL session for advisory-lock ownership |
| External HTTP | Native `fetch` | GeoSearch, PLUTO, Building Footprints, Socrata |
| Concurrency control | Bottleneck | Limits concurrent and paced external requests |
| Logging | Pino | Structured application and ingestion logs |
| Unit / behavior tests | Jest | Business logic and ingestion tests |
| API tests | Supertest | HTTP endpoint tests |
| Security headers | Helmet | Standard HTTP security headers |
| API rate limiting | express-rate-limit | Basic protection against excessive requests |
| Containers | Docker | Reproducible application runtime |
| Local orchestration | Docker Compose | Starts PostgreSQL, API, and worker together |

---

## 3. High-Level Architecture

```text
                         Client
                           |
                           v
                  +----------------+
                  |  Express API   |
                  |----------------|
                  | Zod            |
                  | Helmet         |
                  | Rate Limiting  |
                  +--------+-------+
                           |
                         Prisma
                           |
                           v
                  +----------------+
                  |   PostgreSQL   |
                  +----------------+
                           ^
                           |
                           |
                  +--------+-------+
                  | Ingestion      |
                  | Worker         |
                  |----------------|
                  | Scheduler      |
                  | Watchlist Sync |
                  +--------+-------+
                           |
                      Bottleneck
                           |
                      Native fetch
                           |
                           v
                  +----------------+
                  | NYC Open Data  |
                  | / Socrata      |
                  +----------------+
```

The API and ingestion worker run as separate processes but share the same codebase and PostgreSQL database.

---

## 4. Application Components

### 4.1 Express API

The Express application exposes the public HTTP interface.

Primary responsibilities:

- Accept property creation and lookup requests.
- Accept bulk BBL registration requests and route them through the batch-resolution path.
- Validate incoming payloads and query parameters.
- Invoke application services.
- Read property and ECB data from PostgreSQL.
- Return pagination, freshness, and coverage metadata.
- Apply basic HTTP security middleware.

The HTTP layer should remain thin. Business logic belongs in services rather than directly inside route handlers.

Example flow:

```text
HTTP Request
    |
    v
Express Route
    |
    v
Zod Validation
    |
    v
Application Service
    |
    v
Prisma / PostgreSQL
```

---

## 5. Property Resolution

### 5.1 Purpose

The property resolver converts either:

- a free-text NYC address, or
- a BBL

into a canonical stored property containing:

- normalized address
- borough
- block
- lot
- BBL
- one or more BINs

A property is resolved once and the resulting identifiers are persisted.

Resolution is idempotent at two levels:

```text
same normalized input
    -> same stored property mapping

same canonical BBL
    -> same canonical property row
```

Single-property resolution and bulk BBL registration share normalization and persistence logic, but the bulk path uses bounded source queries rather than invoking the single-property network flow once per item.


### Address Normalization Rules

Address normalization is conservative. It may normalize casing, repeated whitespace, and supported unit syntax, but it must preserve punctuation that is part of NYC address identity.

In particular, Queens hyphenated house numbers are preserved exactly:

```text
"37-15 82nd Street"
-> house number remains "37-15"
```

The normalizer must not transform this into:

```text
3715
37 15
37–15 interpreted as a numeric range
```

The preserved hyphenated house number is used both for resolver input and for the normalized-input idempotency key.

### 5.2 Resolution Flow

Before any external resolution call, the resolver normalizes the input and checks whether that exact normalized input has already been resolved.

```text
Input
  |
  v
Normalize input
  |
  v
property_resolution_inputs lookup
   |                 |
 found            not found
   |                 |
   v                 v
return stored     resolve externally
property             |
                     v
              persist property
              + input mapping
```

This makes "resolve once" a database-enforced behavior rather than an application convention.

For a normal address:

```text
Original address
      |
      v
Parse and preserve:
- normalized base address
- unit designator, if present
      |
      v
GeoSearch(base address)
      |
      v
Deterministic candidate selection
      |
      v
Canonical parcel/building context
      |
      v
PLUTO
      |
      v
Building Footprints
      |
      v
Valid BIN(s)
      |
      v
Persist property
      |
      v
Persist normalized input -> property mapping
```

GeoSearch candidate selection is deterministic. The resolver accepts only candidates that provide the identifiers required for downstream resolution and does not silently guess when the result is genuinely ambiguous. The selected result metadata and confidence are stored with the resolution-input record.

For a direct BBL input:

```text
Input BBL
   |
   v
Normalize / validate
   |
   v
property_resolution_inputs lookup
   |
   v
Parcel classification
   |
   v
PLUTO / condo mapping / Building Footprints
   |
   v
Canonical property + BINs
   |
   v
Persist input mapping
```

For a condominium unit BBL, the unit parcel and the DOB building parcel are resolved explicitly through NYC Digital Tax Map datasets:

```text
UNIT_BBL
   |
   v
Digital Tax Map: Condominium Units
dataset: eguu-7ie3
lookup: unit_bbl = input BBL
   |
   v
CONDO_BASE_BBL
   |
   +------------------------------+
   |                              |
   v                              v
Digital Tax Map:             Building Footprints
Condominiums                 lookup by BASE_BBL
dataset: p8u6-a6it                |
lookup: condo_base_bbl            v
   |                           BIN(s)
   v
CONDO_BILLING_BBL
   |
   v
Building Footprints
MAPPLUTO_BBL validation /
PLUTO-compatible parcel lookup
```

For an address that contains a unit designator, the resolver does not assume that GeoSearch identifies the condo unit itself.

```text
"419 E 84 St Apt 12C"
        |
        v
extract:
base address = "419 E 84 St"
unit_designation = "12C"
        |
        v
GeoSearch(base address)
        |
        v
resolve building / condo base context
        |
        v
Digital Tax Map: Condominium Units
filter by condo/base context
AND unit_designation = "12C"
        |
        v
exactly one match?
   |             |
  yes            no
   |             |
UNIT_BBL       explicit unresolved /
   |           ambiguous resolution
   v
existing condo-unit BBL flow
```

A condo-unit address must resolve to exactly one unit match. If the unit designator is missing, unmatched, or ambiguous, the resolver fails explicitly rather than selecting an arbitrary unit.

The resolver preserves both the original normalized input and the extracted unit designator so two unit addresses in the same building remain distinct resolution inputs.

### 5.3 Property Identity

BBL is the canonical parcel-level identifier.

BIN represents a building and is the preferred join key for DOB ECB Violations.

A single property may map to multiple BINs, so BINs are stored in a separate relational table rather than in a single property column.

Placeholder BINs are not valid building identifiers for ingestion. Any BIN whose last six digits are `000000` is treated as an unassigned/placeholder BIN and is not inserted into the tracked watchlist.

```text
Resolved BIN
    |
    v
ends with 000000?
   /          \
 yes          no
  |            |
discard      persist
```

A property with no valid BIN is not reported as `CHECKED + empty`. It remains unscannable/not checked with an explicit reason such as `NO_VALID_BIN`.

---


### 5.4 Property Identifier Versioning

`properties.identifier_version` represents the property's effective valid BIN set.

It changes **if and only if** that effective valid BIN set changes.

All writes that can alter `property_bins` go through one application service/repository
operation. Callers do not modify `property_bins` directly.

That operation performs comparison, mutation, version increment, and coverage invalidation
in one database transaction:

```text
BEGIN

lock property row

read current effective valid BIN set
compute next effective valid BIN set

if next_set == current_set:
    leave property_bins unchanged
    leave identifier_version unchanged
    leave coverage unchanged

if next_set != current_set:
    mutate property_bins so it exactly matches next_set

    UPDATE properties
    SET identifier_version = identifier_version + 1

    UPDATE property_dataset_coverage
    SET status = NOT_CHECKED,
        status_reason = IDENTIFIERS_CHANGED
    WHERE property_id = P
      AND dataset = DOB_ECB_VIOLATIONS

COMMIT
```

This transaction is the only supported mutation path for the effective BIN set.

Examples:

```text
add another address/input alias only
-> BIN set unchanged
-> identifier_version unchanged
-> coverage unchanged

re-resolution returns the same effective valid BIN set
-> identifier_version unchanged

effective valid BIN set changes
-> property_bins changes
-> identifier_version increments exactly once
-> current ECB coverage is invalidated atomically
```

When a new ingestion run snapshots Property<->BIN associations, it also stores the current
`identifier_version` as `property_identifier_version`.

Successful coverage publication requires:

```text
current properties.identifier_version
==
snapshot property_identifier_version
```

If the run itself completes successfully but the property identifier set changed after the
snapshot:

```text
run.status = COMPLETED

property coverage:
  remains / becomes NOT_CHECKED
  status_reason = IDENTIFIERS_CHANGED_AFTER_SNAPSHOT
```

The next run snapshots and scans the new BIN set.

Failure publication uses the **same version guard**:

```text
if current identifier_version == snapshot property_identifier_version:
    FAILED / SOURCE_CHANGED may update this property's attempt coverage

if current identifier_version != snapshot property_identifier_version:
    the old run must not overwrite the property's newer coverage state
```

This prevents an older run from publishing either successful or failed coverage for a newer
property-identifier state.

---


### 5.5 Building Footprint Identifier Cross-Check

Building Footprints remains a source for BIN discovery, but non-condo resolution does not
silently trust a footprint-to-lot association when NYC source identifiers disagree.

For a non-condo property, the canonical parcel BBL is established from the resolver/PLUTO
path. Each candidate Building Footprint is validated as follows:

```text
candidate footprint
      |
      v
MAPPLUTO_BBL present?
   |             |
  yes            no
   |             |
   v             v
MAPPLUTO_BBL     BASE_BBL
must equal       must equal
canonical BBL    canonical BBL
      |
      v
mismatch?
   |        |
  yes       no
   |        |
   v        v
explicit   candidate BIN
identifier accepted
conflict
```

If `MAPPLUTO_BBL` is present, it is preferred for the MapPLUTO/parcel cross-check.

For address resolution, when GeoSearch also returns a BIN, that value is treated as
additional corroborating evidence. A direct contradiction between GeoSearch and the
validated footprint mapping is not silently resolved by guessing; the resolver returns an
explicit source/identifier conflict for manual investigation or retry.

This rule does not add another external dependency. It only cross-checks identifiers already
returned by the selected NYC sources.

Condo resolution keeps its separate condo-unit/base/billing flow and its existing
`MAPPLUTO_BBL` validation.


## 6. Watchlist Ingestion Strategy

ECB Violations are fetched only for BINs that belong to tracked properties.

### 6.1 Measured Scale

Testing showed that the watchlist strategy is efficient at the required scale:

- The tested watchlist transferred approximately 0.86 MB compared with approximately 12.55 MB for citywide changes over the same window.
- The watchlist data pull completed in approximately 5.5 seconds with concurrency 10.
- A 10,000-property PLUTO sample produced 10,087 BINs.
- The complete initial ECB history for those BINs was approximately 2,879 rows, 3.23 MB, and 11 ECB data-page requests.
- The initial data backfill completed in approximately 4.5 seconds.

The implemented architecture additionally performs one dataset-metadata request at the start and one at the end of each run.

Therefore, with no retries and one data page per BIN batch:

```text
10,087 BINs:
  data-page calls = 11
  metadata calls  = 2
  baseline total  = 13

```

Retries and additional pagination pages are counted on top of these baseline totals.

The watchlist therefore remains small enough to query directly in batches while avoiding storage and transfer of unrelated citywide data.


### 20,000-Property Projection

The assignment scale target is expressed in **properties**, not BINs.

Measured:

```text
10,000 properties
-> 10,087 unique valid BINs
-> 1.0087 BINs/property in this sample
```

If that observed ratio is used only as a planning estimate:

```text
20,000 properties
x 1.0087 BINs/property
≈ 20,174 unique valid BINs

ceil(20,174 / 1,000)
= 21 data batches

21 data-page calls
+ 2 metadata calls
= ~23 baseline Socrata calls
```

This is an estimate, not a measured 20,000-property result. The actual value depends on the property sample, shared BINs, multi-building lots, and deduplication.

The general formula is:

```text
baseline_calls =
ceil(unique_valid_bins / ECB_BATCH_SIZE)
+ additional pagination pages
+ 2 metadata calls
```

Retries are counted separately.

### 6.2 Strategy Evolution: Watchlist vs Dataset Mirror

The implemented strategy is **Watchlist Pull**.

At the assignment scale, the measured data strongly favors watchlist ingestion:

```text
10,000 properties
-> 10,087 unique valid BINs
-> 11 ECB data-page requests
-> +2 metadata requests in the implemented run
-> 13 baseline Socrata requests before retries/additional pages
```

Using the measured BIN/property ratio only as a planning estimate:

```text
20,000 properties
-> ~20,174 unique valid BINs
-> 21 data-page requests
-> +2 metadata requests
-> ~23 baseline Socrata requests
```

The 20,000-property figure is a projection, not a measured result.

#### Rejected strategy: full dataset mirror

A full citywide mirror was not selected because, at the tested portfolio scale, it would transfer and store substantially more unrelated ECB data while providing little benefit to the required query path.

The watchlist design still provides:

```text
- local API reads
- resumable ingestion
- raw provenance
- bounded work
- portfolio-wide queries
```

without maintaining unrelated NYC rows.

#### When to re-evaluate

The decision should be re-evaluated **per NYC dataset**, not globally at a fixed property count.

At 20,000 properties, ECB remains comfortably in watchlist territory based on the measured/projection call counts and transfer volumes.

Adding ten NYC data points does **not** imply multiplying ECB's cost by ten. Different datasets have different:

```text
- row density
- update frequency
- queryability
- identifiers
- payload sizes
- historical depth
```

A dataset becomes a candidate for mirror ingestion when one or more of the following become true:

```text
1. tracked properties represent a substantial fraction of relevant source rows;
2. aggregate watchlist refresh cost approaches the cost of maintaining an incremental citywide copy;
3. source query shape no longer supports efficient bounded watchlist filtering;
4. product requirements require querying untracked NYC properties;
5. cross-portfolio or cross-property change detection benefits materially from a local citywide copy.
```

The switch decision would be based on measured network volume, source-call count, wall time, storage cost, and operational reliability for that specific dataset.

#### Second data point

The next data point would be implemented using the same proven platform primitives:

```text
property identity
ingestion_runs
ingestion_batches
coverage/freshness
locking
bounded execution
structured logging
```

while keeping source-specific fetching and normalization separate.

A reasonable second example is HPD Violations.

#### First refactor

The first refactor would happen **after** a second data point exists.

At that point, only the ingestion concepts proven common across both sources would be extracted into reusable infrastructure:

```text
- run lifecycle
- advisory-lock ownership
- immutable batch snapshots
- bounded batch attempts
- metrics/logging
- coverage state handling
```

Source querying, source identity, parsing, and normalization would remain behind dataset-specific adapters.

This avoids prematurely building a generic ingestion framework before there is a second concrete source proving which abstractions are actually shared.

### 6.3 Ingestion Flow

A BIN batch is a logical unit of work, not necessarily a single HTTP request. Each batch may require multiple ordered Socrata pages.

```text
Scheduler / Manual CLI
        |
        v
Acquire dedicated-session
PostgreSQL advisory lock
        |
        v
Is there an active run?
   |                 |
  no                yes
   |                 |
   v                 v
Create QUEUED      RESUME existing run
ingestion_run          |
   |                   v
   v              Compare current watermark
Snapshot local     to stored immutable start
Property<->BIN     watermark
associations            |
   |                +---+---+
   v                |       |
Build and persist match    mismatch
immutable batches   |       |
   |                v       v
   v             resume   SOURCE_CHANGED
Fetch start        persisted no batch reuse;
metadata           batches   next run starts fresh
   |
 +--+--+
 |     |
ok    terminal failure
 |     |
 v     v
set immutable   FAILED
start watermark START_WATERMARK_FETCH_FAILED
 |
 v
RUNNING
   |
   v
Process persisted
batches

RESUME with matching watermark:
load persisted batch_definitions only
-> never reload/repartition current watchlist
-> skip completed batches
-> continue incomplete batches
        |
        v
For each BIN batch
        |
        v
Fetch ordered Socrata pages
through Bottleneck
        |
        v
Basic JSON / transport validation
        |
        v
Persist raw source versions
        |
        v
Strict Zod / domain validation
        |
        v
Normalize
        |
        v
Write run-scoped
ecb_violation_staging
        |
        v
Mark batch complete

After all batches:
        |
        v
Read dataset metadata again
        |
        v
Store source_watermark_at_end
        |
        v
All batches successful
AND best-effort watermark guard unchanged?
        |
   +----+----+
   |         |
  yes        no
   |         |
   v         v
Promote     SOURCE_CHANGED / FAILED
staging     no promotion
to live         |
   |            v
   v        Update FAILED
Negative    attempt coverage
reconciliation  |
   |            v
   v        terminal run state
Update successful coverage
   |
   v
COMPLETED
```

Raw persistence happens before strict domain validation. This protects against domain parsing and normalization failures after minimal row identity/version extraction.

Normalized candidates are **not written directly to the live `ecb_violations` table during the scan**. They are staged under the current `run_id`.

The live normalized state changes only during promotion after the run has completed successfully enough to be accepted. A failed or `SOURCE_CHANGED` run may leave raw/staging data for diagnostics, but it does not change the last accepted live ECB state.

Pagination uses an explicit page size, stable ordering, and a bounded maximum number of pages per batch.

The implementation does **not** treat Socrata `$offset` as a durable resume cursor. A partially completed BIN batch is restarted from its first page after process failure. Because raw inserts and staging writes are idempotent, replaying that partial batch is safe.

At the beginning and end of each run, the worker observes the Socrata dataset metadata `rowsUpdatedAt` value. This is used as a **best-effort upstream-change guard**, not as a transactional snapshot or revision token.

If the observable watermark changes during the run, the run ends as `SOURCE_CHANGED`, staging is not promoted, negative reconciliation does not run, and the next ingestion starts all BIN batches again using the new observed source state.


Pagination bound exhaustion is a hard failure condition.

```text
if pages_fetched == SOCRATA_MAX_PAGES_PER_BATCH
and the last page indicates that more source data may remain:
    batch = FAILED_PAGE_LIMIT
```

A batch that reaches the configured pagination ceiling while additional data may remain is never marked complete. Consequently, the run cannot promote staging, cannot perform negative reconciliation, and cannot produce `CHECKED` coverage from that incomplete batch.

### 6.4 Batch Size and Concurrency

Operational values are configuration, not hard-coded behavior.

Example environment variables:

```env
ECB_BATCH_SIZE=1000
SOCRATA_PAGE_SIZE=50000
SOCRATA_MAX_PAGES_PER_BATCH=100
SOCRATA_CONCURRENCY=10
SOCRATA_REQUEST_TIMEOUT_MS=15000
SOCRATA_MAX_RETRIES=3
MAX_BATCH_ATTEMPTS_PER_RUN=3
INGEST_INTERVAL_MS=604800000
```

Every batch, retry, request timeout, and loop has an explicit bound.

---

### 6.5 Batch Attempt Boundaries

HTTP-request retry limits and logical batch-attempt limits are separate.

```text
SOCRATA_MAX_RETRIES
= transient retries for one HTTP request

MAX_BATCH_ATTEMPTS_PER_RUN
= maximum logical executions of one BIN batch within the same ingestion run
```

Example:

```text
batch attempt 1
  -> fails

batch attempt 2
  -> fails

batch attempt 3
  -> fails

batch = TERMINAL_FAILED
run   = FAILED
```

Once `MAX_BATCH_ATTEMPTS_PER_RUN` is exhausted, that batch is terminal for the current run. Automatic resume does not retry it indefinitely.

A manually triggered or scheduled **new run** is a new operational decision with a new attempt budget.

`attempt_count` therefore measures logical batch executions within one run, not internal HTTP retries.


## 7. Ingestion Run Lifecycle

Each ingestion execution receives a durable database record.

Example lifecycle:

```text
queued
  |
  v
running
  |
  +----------> FAILED
  |
  +----------> SOURCE_CHANGED
  |
  v
COMPLETED
```

A run records:

- trigger type
- start time
- finish time
- dataset source watermark at run start and end (`rowsUpdatedAt`)
- number of BINs scanned
- ECB data-page calls
- Socrata metadata calls
- retry calls
- total Socrata calls
- rows fetched
- rows written
- failures
- final status

Only one active ingestion run record per dataset may exist at a time.

A partial unique index enforces:

```text
UNIQUE(dataset)
WHERE status IN ('queued', 'running')
```

This prevents creation of competing active run records.

Execution ownership is protected separately with a PostgreSQL **session-level advisory lock** for the ECB ingestion job.

The advisory lock is acquired and held on a **dedicated PostgreSQL connection/session for the entire ingestion execution**. It is not acquired and released through unrelated pooled Prisma queries.

A small `pg` (`node-postgres`) connection can own the lock while Prisma remains the main database-access layer for application data.

```text
dedicated PostgreSQL session
          |
          v
pg_try_advisory_lock(dataset_lock_key)
     |                |
   fail             success
     |                |
report active       keep session open
executor                 |
                         v
                   resume/create run
                         |
                         v
                   execute ingestion
                         |
                         v
                   advisory_unlock
                         |
                         v
                   release session
```

If an unfinished run already exists, the lock holder resumes that run instead of creating a new one.

This provides both operational visibility and a real execution mutex across processes.

---




### Advisory-Lock Session Loss

The dedicated PostgreSQL session that owns the advisory lock is also the worker's execution
authority.

**Invariant: loss of that session immediately revokes permission to continue the ingestion
run.**

The lock-owning `pg.Client` registers both `error` and `end` handlers.

If either fires unexpectedly while ingestion is active:

```text
lock connection lost
        |
        v
execution_authorized = false
        |
        v
AbortController.abort()
        |
        +--> cancel/stop new Socrata work
        +--> stop launching batch attempts
        +--> reject mark-batch-complete writes
        +--> reject promotion / reconciliation
        +--> reject terminal run publication
        |
        v
terminate worker process non-zero
```

The ingestion service checks execution authority before state-changing run/batch operations.
A worker that has lost the advisory-lock session must not continue only because its Prisma
pool is still healthy.

This fail-stop behavior is sufficient for the take-home design.

For a stronger production implementation, the next hardening step would be a fencing
token / executor epoch stored on the run and required by every state-changing write so a
superseded executor is rejected by PostgreSQL even during unusual network-partition races.

### Run Initialization and Start Watermark

A durable `ingestion_run` record is created immediately after the dataset advisory lock is acquired so even initialization failures are recorded.

Initial state:

```text
status = QUEUED
initialization_complete = false
source_watermark_at_start = NULL
```

The local work snapshot is then created atomically in **one PostgreSQL transaction**.

```text
BEGIN

INSERT all ingestion_run_property_bins rows

derive DISTINCT valid BINs from that snapshot

INSERT all ingestion_batches with immutable batch_definition

UPDATE ingestion_run:
  expected_property_bin_count = snapshot row count
  expected_bin_count = distinct BIN count
  expected_batch_count = batch count
  initialization_complete = true

COMMIT
```

If the worker crashes anywhere inside this transaction, PostgreSQL rolls back the entire snapshot/batch initialization. No partial `ingestion_run_property_bins` or partial batch set is considered initialized.

After the initialization transaction commits:

```text
fetch Socrata rowsUpdatedAt = X
      /   \
 success   terminal failure
    |           |
    v           v
BEGIN DB tx     terminalize run as FAILED
validate init   error =
write X         START_WATERMARK_FETCH_FAILED
set RUNNING
COMMIT
```

The network request is outside the database transaction. Persisting `source_watermark_at_start = X` and transitioning the run to `RUNNING` happen atomically in the same transaction.

`source_watermark_at_start` may transition only once:

```text
NULL -> observed watermark
```

No durable state exists with `QUEUED + initialization_complete=true + source_watermark_at_start != NULL`.

The only durable states around start-watermark acquisition are:

```text
QUEUED + initialized + watermark = NULL
RUNNING + initialized + watermark = X
```


After it has been set, it is immutable for that `run_id`.

Recovery rules for `QUEUED` runs are explicit:

```text
QUEUED + initialization_complete = false
-> rerun the entire initialization transaction

QUEUED + initialization_complete = true
       + source_watermark_at_start = NULL
-> do not rebuild snapshot/batches
-> fetch the start watermark
-> atomically persist watermark + RUNNING

RUNNING
-> normal resume using persisted snapshot/batches
```

Before transition to `RUNNING`, application-level assertions verify that the persisted initialization matches:

```text
expected_property_bin_count
expected_bin_count
expected_batch_count
```

These counts are integrity assertions/observability values, not cross-table SQL `CHECK` constraints.

State invariant:

```text
RUNNING / COMPLETED / SOURCE_CHANGED
require:
  initialization_complete = true
  source_watermark_at_start IS NOT NULL
```

A run may be `FAILED` before either condition is true because failure can happen during initialization or start-watermark acquisition.

### Immutable Run Watermark

`source_watermark_at_start` is written exactly once after the durable `QUEUED` run has been created and the initial Socrata metadata request succeeds. It is then immutable for that `run_id`.

```text
new run R
   |
   v
create QUEUED run
   |
   v
atomically initialize
Property<->BIN snapshot + batches
   |
   v
read current rowsUpdatedAt = X
   |
   v
store R.source_watermark_at_start = X
   |
   v
transition to RUNNING
   |
   v
never overwrite X
```

On resume, the worker does **not** rewrite the start watermark. It first compares the currently observed dataset watermark to the stored immutable value.

```text
resume run R
stored start watermark = X
        |
        v
read current watermark
        |
   +----+----+
   |         |
  X          != X
   |         |
resume       mark R = SOURCE_CHANGED
pending      do not reuse completed batches
work         start a new run from all batches
```

This prevents a resumed run from combining batches observed before and after a source update while still passing the final guard.

### Immutable Batch Definitions

The tracked-BIN snapshot and batch partition are created exactly once for a new ingestion run.

```text
NEW RUN
  |
  v
snapshot current valid Property<->BIN associations
into ingestion_run_property_bins
  |
  v
SELECT DISTINCT bin for this run
  |
  v
sort
  |
  v
partition into deterministic batches
  |
  v
persist batch_definition for every batch
```

For the lifetime of that `run_id`, each `batch_definition` is immutable.

```text
RESUME
  |
  v
load existing ingestion_batches
  |
  v
use persisted batch_definition only
  |
  +--> completed -> skip
  |
  +--> incomplete -> retry/continue
```

A resumed run never reloads the current watchlist and never recomputes batch membership.

If properties or BINs are added while a run is in progress, they are intentionally excluded from that run and are picked up by the next ingestion run.

This preserves the meaning of `batch_number`, completed progress, and property/BIN coverage across process restarts.

## 8. Resumable Batch Processing

The complete watchlist is split into deterministic batches.

Example:

```text
ingestion_run
   |
   +-- batch 1  -> completed
   +-- batch 2  -> completed
   +-- batch 3  -> failed
   +-- batch 4  -> pending
   +-- batch 5  -> pending
```

Each batch stores enough state to be retried safely, including its deterministic logical BIN set and execution status.

A failed batch is retryable only while its `attempt_count` is below `MAX_BATCH_ATTEMPTS_PER_RUN`. Exhausting that bound makes the batch terminally failed for the current run and forces the run to `FAILED`.

Typical progress fields include:

```text
batch_number
status
pages_fetched
rows_fetched
attempt_count
last_error
```

If the worker stops during a run, the restart path first validates that the current dataset watermark still matches the run's immutable `source_watermark_at_start`. If it does not, the old run becomes `SOURCE_CHANGED` and no completed batches from that run are reused.

If the watermark still matches:

```text
Worker restart
      |
      v
Find unfinished run
      |
      v
Load incomplete batches
      |
      v
Skip completed batches
      |
      v
Retry pending / retryable failed work
only while attempt_count < MAX_BATCH_ATTEMPTS_PER_RUN
```

Completed batches are not fetched again simply because the process restarted.

For a partially completed batch, the worker restarts that batch from its first Socrata page. It does not resume from a persisted OFFSET position.

Because raw inserts and staging writes are idempotent, replaying pages already seen within that partial batch is safe.

The database, rather than process memory, is the durable source of run and batch progress.

---

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


## 13. Prisma

Prisma is the main application data-access layer.

Responsibilities:

- PostgreSQL schema mapping
- typed application queries
- relationships
- migrations
- transactions
- ordinary inserts, updates, and reads

For ingestion paths where a bulk SQL operation is significantly simpler or more efficient, parameterized SQL can be executed through the database layer while keeping Prisma as the primary schema and migration system.

Prisma is not used to own the long-lived PostgreSQL advisory lock because ordinary Prisma access is pooled. The ingestion executor uses one dedicated `pg` connection solely to acquire, hold, and release the session-level lock.

Database schema changes are committed as migrations so the same database structure is created when the project is run on another machine.

---

## 14. Zod Validation

Zod is used at two different validation levels.

### API input

Examples:

- property creation payload
- BBL format
- pagination parameters
- boolean filters
- bulk import payloads

### External NYC data

External responses first receive minimal transport-level validation so they can be safely parsed and persisted as raw JSON.

```text
HTTP response
    |
    v
JSON parsing / minimal structural validation
    |
    v
Raw persistence
    |
    v
Strict domain validation
    |
    v
Normalization
```

Strict Zod schemas are applied after raw persistence to validate the fields required by the normalized ECB model.

If strict validation or normalization fails, the raw payload remains available, the error is recorded, and the affected batch is marked partial or failed. This preserves the ability to fix parsing logic and re-derive normalized data without fetching the source again.

---

## 15. External HTTP Clients

Node.js native `fetch` is used for outbound HTTP.

External systems are wrapped in dedicated clients, for example:

```text
GeoSearchClient
PlutoClient
CondoUnitsClient
CondominiumsClient
BuildingFootprintsClient
SocrataClient
```

These clients are responsible for:

- URL construction
- query parameters
- authentication tokens when configured
- stable ordering for paginated Socrata queries
- page size and pagination parameters
- Socrata dataset metadata / `rowsUpdatedAt` retrieval
- timeout handling
- HTTP status validation
- parsing
- logging
- retryable error classification

Business services do not construct Socrata or GeoSearch HTTP calls directly.

---


### ECB Socrata Query Contract

Every DOB ECB page query explicitly requests the Socrata system fields required by the ingestion schema:

```text
$select=:id,:updated_at,*
```

Queries may use these fields for stable ordering as well:

```text
$order=:updated_at,:id
```

This is a required client invariant. The ingestion schema depends on:

```text
socrata_row_id = :id
source_row_updated_at = :updated_at
```

and these fields must not be assumed to appear implicitly in SODA 2.1 responses.

## 16. Bottleneck

Bottleneck controls external API concurrency and pacing.

Example configuration:

```text
maxConcurrent = SOCRATA_CONCURRENCY
```

Optionally:

```text
minTime = configured delay between requests
```

It sits immediately around external Socrata operations:

```text
Ingestion batches
       |
       v
Bottleneck
       |
       v
SocrataClient
```

This ensures a configuration or code change cannot accidentally create unbounded parallel requests.

---

## 17. Scheduling and Manual Execution

The worker process handles scheduled ingestion.

The schedule interval comes from configuration.

```text
Worker start
    |
    v
Read schedule configuration
    |
    v
Start ingestion at configured interval
```

Manual execution is exposed through Docker so the reviewer needs only Docker installed:

```bash
docker compose run --rm worker npm run ingest:ecb
```

Scheduled and manual executions call the same ingestion service.

Before executing ingestion, the worker acquires the PostgreSQL session-level advisory lock for the dataset on a dedicated PostgreSQL connection. Only the process holding that session may resume or create work.

```text
try ECB advisory lock
       |
  +----+----+
  |         |
 fail     success
  |         |
report      unfinished run?
active      |          |
executor   yes         no
            |          |
          resume      create
```

If a manual trigger arrives while another process owns the ECB execution lock, it reports the active executor/run rather than starting competing work.

If the dedicated advisory-lock connection is lost during execution, that worker immediately loses execution authority and aborts rather than continuing through surviving Prisma connections.

The CLI does not contain a second implementation of the ingestion logic.

---

## 18. API Surface

### Create or resolve a property

```http
POST /properties
```

Accepts either:

```json
{
  "address": "350 5th Avenue, Manhattan"
}
```

or a unit-aware address such as:

```json
{
  "address": "419 E 84 St Apt 12C"
}
```

or:

```json
{
  "bbl": "1008350041"
}
```

---

### Bulk property registration

```http
POST /properties/bulk
```

Request contract:

```text
maximum BBLs per request: 10,000
default API body limit: 512kb
```

The Express JSON parser is configured explicitly rather than relying on its default request-size limit.

Bulk registration is a dedicated batch path rather than a loop over the single-property resolver.

For BBL-based bulk import:

```text
Input BBL list
      |
      v
Validate + deduplicate
      |
      v
Skip GeoSearch
      |
      v
Split BBLs into bounded chunks
      |
      +-------------------------+
      |                         |
      v                         v
Bulk PLUTO queries      Bulk Building Footprints queries
      |                         |
      +------------+------------+
                   |
                   v
        Resolve condo mappings where needed
                   |
                   v
         Join results in application
                   |
                   v
        Bulk PostgreSQL upserts
```

The bulk path avoids one external request per property. PLUTO, condominium mapping datasets, and Building Footprints are queried in bounded groups using bulk predicates where supported.

This is also the path used for the 10,000-property scale seed/run.

The scale seed is executed from the application container:

```bash
docker compose run --rm worker npm run seed:scale
``` The 10,000 BBLs are obtained directly from PLUTO and do not require geocoding.

---

### Get property

```http
GET /properties/:id
```

Returns the locally stored canonical property and identifiers.

---

### Get property ECB violations

```http
GET /properties/:id/ecb-violations
```

Example query parameters:

```text
openOnly=true
unpaidOnly=true
cursor=...
limit=...
```

Filter semantics are explicit:

```text
openOnly=true
=> ecb_violation_status = 'ACTIVE'

unpaidOnly=true
=> balance_due > 0
```

`openOnly` and `unpaidOnly` are independent filters.

Returns locally stored violations plus coverage and freshness metadata.

Only rows from the last accepted live normalized state with `is_current = true` are returned by default. Run-scoped staging rows are never served.

The endpoint **must** return violations newest first:

```sql
ORDER BY
  issue_date DESC NULLS LAST,
  source_id DESC
```

Cursor pagination for this endpoint uses the same tuple:

```text
(issue_date, source_id)
```

so every next-page query preserves exactly the same ordering semantics.

---

### Query across tracked properties

```http
GET /ecb-violations
```

Supports portfolio-wide scanning patterns without requiring one request per property.

Possible query parameters include:

```text
updatedSince
unpaidOnly
cursor
limit
```

---



### Portfolio Membership Invariant

`ecb_violations.is_current` means the row is current according to the last accepted scan of
that BIN. It does **not** by itself mean that the BIN is still part of the current tracked
property watchlist.

Therefore the portfolio endpoint applies both conditions:

```sql
WHERE e.is_current = true
  AND EXISTS (
      SELECT 1
      FROM property_bins pb
      WHERE pb.bin = e.bin
  )
```

This prevents a violation from a BIN that is no longer associated with any tracked property
from remaining visible forever simply because that BIN will no longer participate in future
negative reconciliation.

The core `/ecb-violations` feed remains violation-level, not property×violation-level. A
violation whose BIN is shared by multiple tracked properties is returned once.

If a future API intentionally expands results per property, that would be a different
contract and its stable ordering/cursor would also include `property_id`.

### Portfolio Query Update Semantics

For:

```http
GET /ecb-violations?updatedSince=<timestamp>
```

`updatedSince` means:

```text
source_row_updated_at > supplied timestamp
```

where:

```text
source_row_updated_at = Socrata :updated_at
```

This is intentionally different from:

```text
issue_date   = when the violation was issued
updated_at   = local database write/promotion time
```

Results using `updatedSince` are ordered by:

```text
source_row_updated_at DESC,
source_id DESC
```

and cursor pagination uses the same ordering key.

This endpoint provides a portfolio-wide feed of source rows that were updated by Socrata after the supplied timestamp. It is not a full deletion/change-event stream; explicit change events remain outside the core assignment scope.


Portfolio-wide ECB queries use the same live-state semantics as property-scoped ECB queries.

By default:

```text
is_current = true
```

Therefore:

```http
GET /ecb-violations
```

returns only violations in the last accepted live state unless a future explicit historical option is added.

With `updatedSince`:

```text
WHERE is_current = true
  AND source_row_updated_at > supplied timestamp
  AND EXISTS current property_bins membership for the violation BIN
```

The core endpoint is not a deletion/history feed.

## 19. Pagination

Large result endpoints are paginated.

Cursor-based pagination is preferred for violation feeds where rows may change between requests.

For the property ECB endpoint, stable ordering is mandatory:

```text
issue_date DESC NULLS LAST
source_id DESC
```

The cursor represents the tuple `(issue_date, source_id)` of the last item in the previous
page. Because `issue_date` may be `NULL`, the next-page predicate follows the explicit
NULL-aware branches below rather than using a plain row-tuple comparator.

Portfolio endpoints may use a different stable ordering when their contract requires it
(for example `source_row_updated_at DESC, source_id DESC` for `updatedSince`).

---


### NULL-Aware Property ECB Keyset Pagination

The property ECB endpoint orders rows by:

```sql
ORDER BY
  issue_date DESC NULLS LAST,
  source_id DESC
```

The implementation must **not** rely on a plain row-tuple comparator such as:

```sql
(issue_date, source_id) < (:cursorDate, :cursorId)
```

because `issue_date` may be `NULL`.

The cursor encodes:

```text
issue_date
source_id
```

and the next-page predicate has two explicit branches.

If the cursor date is non-null:

```sql
WHERE
      issue_date < :cursorDate
   OR (
        issue_date = :cursorDate
        AND source_id < :cursorId
   )
   OR issue_date IS NULL
```

If the cursor date is null:

```sql
WHERE issue_date IS NULL
  AND source_id < :cursorId
```

The same filters (`is_current`, property/BIN membership, `openOnly`, `unpaidOnly`) are
applied before the ordering/cursor predicate as appropriate.

This guarantees traversal from dated rows into the `NULL` tail and continued pagination
within the `NULL` tail.


## 20. Logging

Pino is used for structured JSON logging.

Application logs contain operational information rather than complete source payloads.

Example batch log:

```json
{
  "runId": "abc123",
  "batch": 4,
  "binCount": 1000,
  "rowsFetched": 74,
  "durationMs": 420,
  "message": "ECB batch completed"
}
```

Example run summary:

```json
{
  "runId": "abc123",
  "properties": 10000,
  "uniqueBins": 10087,
  "socrataDataCalls": 11,
  "socrataMetadataCalls": 2,
  "socrataRetryCalls": 0,
  "socrataTotalCalls": 13,
  "rowsFetched": 2879,
  "failures": 0,
  "durationMs": 4500
}
```

Secrets, tokens, connection strings, and complete upstream payloads are not written to logs.

---

## 21. Security Baseline

Authentication is outside the assignment scope, but the service still applies basic defensive controls.

### HTTP protection

```text
Request
   |
   v
express-rate-limit
   |
   v
Helmet
   |
   v
Request body size limit
   |
   v
Zod validation
   |
   v
Application service
   |
   v
Prisma / parameterized SQL
```

Controls include:

- standard security headers with Helmet
- request rate limiting
- explicit JSON body size limit

The API uses an explicit parser limit, for example:

```ts
app.use(express.json({ limit: process.env.API_BODY_LIMIT ?? "512kb" }));
```

The bulk endpoint separately validates a maximum of 10,000 BBLs per request.
- runtime input validation
- parameterized database access
- no raw SQL built from concatenated user input
- generic client-facing error responses
- detailed internal error logging
- no stack traces returned to clients

---

## 22. Secrets and Configuration

Operational values are supplied through environment variables.

Example:

```env
DATABASE_URL=
SOCRATA_APP_TOKEN=

INGEST_INTERVAL_MS=
ECB_BATCH_SIZE=
SOCRATA_PAGE_SIZE=
SOCRATA_MAX_PAGES_PER_BATCH=
SOCRATA_CONCURRENCY=
SOCRATA_REQUEST_TIMEOUT_MS=
SOCRATA_MAX_RETRIES=

API_RATE_LIMIT=
API_BODY_LIMIT=512kb
```

The repository contains:

```text
.env.example
```

but does not commit:

```text
.env
```

Secrets are never hard-coded.

---

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

## 25. Docker Architecture


### Migration Startup Ordering

Clean-machine startup uses one deterministic Compose dependency chain:

```text
postgres
   |
   | service_healthy
   v
migrate
(prisma migrate deploy)
   |
   | service_completed_successfully
   +------------------+
   |                  |
   v                  v
api                worker
```

The `migrate` service uses the same application image and runs:

```bash
npx prisma migrate deploy
```

`api` and `worker` do not run migrations themselves.

This avoids a migration race between the two long-running processes and preserves the assignment's one-command startup requirement:

```bash
docker compose up --build
```

The application image must include the Prisma CLI required by the `migrate` service.



Docker Compose starts the complete application from a clean machine.

```text
docker compose up
        |
        +-- postgres
        |
        +-- api
        |
        +-- worker
```

The API and worker can use the same application image with different startup commands.

Example:

```text
API container
  -> npm run start:api

Worker container
  -> npm run start:worker
```

PostgreSQL uses a persistent Docker volume.

Database migrations run as part of application initialization or through a dedicated migration startup step before the API and worker begin processing requests.

---

## 26. Suggested Source Structure

```text
src/
|
+-- app.ts
+-- server.ts
|
+-- config/
|   +-- env.ts
|
+-- routes/
|   +-- properties.routes.ts
|   +-- violations.routes.ts
|
+-- services/
|   |
|   +-- property-resolver/
|   |   +-- property-resolver.service.ts
|   |   +-- property-input.service.ts
|   |
|   +-- ecb/
|       +-- ingestion.service.ts
|       +-- normalization.service.ts
|       +-- promotion.service.ts
|       +-- coverage.service.ts
|
+-- clients/
|   +-- geosearch.client.ts
|   +-- pluto.client.ts
|   +-- condo-units.client.ts
|   +-- condominiums.client.ts
|   +-- building-footprints.client.ts
|   +-- socrata.client.ts
|
+-- workers/
|   +-- ingestion.worker.ts
|   +-- scheduler.ts
|
+-- schemas/
|   +-- property.schema.ts
|   +-- ecb.schema.ts
|
+-- db/
|   +-- prisma.ts
|
+-- logging/
|   +-- logger.ts
|
+-- cli/
|   +-- ingest-ecb.ts
|
+-- tests/

prisma/
|
+-- schema.prisma
+-- migrations/

Dockerfile
docker-compose.yml
.env.example
README.md
DESIGN.md
```

---

## 27. End-to-End System Flow

### Property registration

Single property:

```text
Client
  |
  v
Express
  |
  v
Zod
  |
  v
PropertyResolver
  |
  +--> GeoSearch when needed
  +--> PLUTO
  +--> Condo datasets when needed
  +--> Building Footprints
  |
  v
PostgreSQL
```

Bulk BBL registration:

```text
Client / seed command
      |
      v
Validate + deduplicate BBLs
      |
      v
Bounded bulk source queries
      |
      +--> PLUTO
      +--> Condo datasets when needed
      +--> Building Footprints
      |
      v
Join + normalize
      |
      v
Bulk PostgreSQL upsert
```

### Scheduled ECB synchronization

```text
Worker Scheduler / Manual CLI
      |
      v
Acquire ECB advisory lock
      |
      v
Existing active run?
   /               \
  no               yes
  |                 |
  v                 v
NEW RUN           RESUME
  |                 |
  v                 v
Create QUEUED     Read current dataset watermark
run                 |
  |                 v
  v              compare with immutable
BEGIN init tx     source_watermark_at_start
  |                 |
  +-> snapshot      +-----------+
  |   Property<->BIN|           |
  +-> create      match      mismatch
  |   all batches   |           |
  +-> mark init     v           v
  |   complete    load        SOURCE_CHANGED
COMMIT            persisted    no batch reuse
  |               batches      next run starts fresh
  v                 |
Fetch start          |
watermark X          |
  |                 |
  v                 |
BEGIN tx            |
set watermark=X     |
set RUNNING         |
COMMIT              |
  |                 |
  +--------+--------+
           |
           v
Process persisted immutable batches
           |
           v
Persist raw source versions
           |
           v
Normalize into run-scoped staging
           |
           v
All batches complete
           |
           v
Read end dataset watermark
           |
           v
Best-effort guard unchanged?
      /             \
    yes              no
     |                |
     v                v
promotion tx      terminal failure tx
- promote live    - no promotion
- reconcile       - publish run failure
- coverage        - eligible property failure
- COMPLETED         coverage with version guard
```

NEW runs create the Property<->BIN snapshot and immutable batches before fetching the start
watermark.

RESUME never reloads the current watchlist and never repartitions batches. It first compares
the current observable dataset watermark to the run's immutable start watermark and then
continues only from persisted batch definitions.


### Client query

```text
Client
  |
  v
Express API
  |
  v
PostgreSQL
  |
  +--> normalized violations
  |
  +--> coverage / freshness
  |
  v
JSON response
```

No external NYC API is called during stored-property or ECB query paths. One-time property registration may call NYC resolution sources.

---

## 28. Architectural Summary

The application consists of three runtime components:

```text
API
Worker
PostgreSQL
```

The major application flows are:

```text
Resolve Property
      |
      v
Persist BBL + BINs
      |
      v
Watchlist Ingestion
      |
      v
Persist Raw + Normalized ECB
      |
      v
Serve Through Local Query API
```

PostgreSQL owns persistent application and ingestion state.

Express exposes the HTTP API.

The worker performs scheduled, paginated watchlist synchronization with durable run and batch progress. Completed batches are resumed safely after ordinary process failure, while partial batches restart from their first Socrata page instead of relying on OFFSET as a durable cursor. If the dataset watermark changes during the run, that run ends as `SOURCE_CHANGED`; the next run restarts all batches against the new baseline.

Prisma manages database access and migrations.

Zod validates API input and performs strict domain validation after raw source persistence.

Bottleneck bounds Socrata concurrency.

PostgreSQL enforces raw/staging/live idempotency, one active run record per dataset, a single execution owner through a dedicated-session advisory lock, resumable batch-level progress, atomic promotion of accepted normalized state, guarded current-state reconciliation, and unique property coverage state.

Pino records structured operational metrics.

Jest and Supertest verify the behaviors that matter for correctness.

Docker Compose provides the complete reproducible runtime.