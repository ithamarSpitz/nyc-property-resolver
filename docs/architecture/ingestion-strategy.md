<!-- GENERATED CONTEXT MODULE. Source of truth: /ARCHITECTURE.md. -->
<!-- Do not edit independently; regenerate from the final architecture if it changes. -->

## 6. Watchlist Ingestion Strategy

ECB Violations are fetched only for BINs that belong to tracked properties.

### 6.1 Measured Scale

Two measurement sets exist in the project history and they serve different purposes.

The **early planning probe** compared watchlist-shaped retrieval with broader citywide retrieval before the final acceptance run:

- approximately 0.86 MB for the tested watchlist versus approximately 12.55 MB for citywide changes over the same window;
- approximately 5.5 seconds for the tested watchlist pull at concurrency 10;
- a 10,000-BBL PLUTO planning sample that yielded 10,087 BINs;
- approximately 2,879 ECB rows (3.23 MB) and 11 ECB data-page requests;
- approximately 4.5 seconds for that initial probe backfill.

Those probe numbers are retained only as exploratory evidence for the watchlist-vs-mirror decision. They are **superseded for submission sizing and scale claims** by the deterministic final acceptance evidence below.

The final acceptance run submitted **10,000 PLUTO BBLs**. Fifteen source/resolver-quality inputs failed registration, leaving **9,985 registered properties** and **10,800 valid BINs**. Accepted ingestion completed with:

```text
11 data calls + 2 metadata calls + 1 retry = 14 observed Socrata calls
81,486 rows fetched/staged/promoted
0 ingestion failures
1,311.004 s ingestion
1,651.394 s end to end
```

At that accepted shape, the no-retry baseline is **13 Socrata calls** (11 data + 2 metadata); retries and additional pagination pages are counted on top.

The watchlist therefore remains small enough to query directly in bounded batches while avoiding storage and transfer of unrelated citywide data.

### 20,000-Property Projection

The assignment scale target is expressed in **properties**, not BINs. Using the final acceptance ratio as a linear planning estimate for **20,000 successfully registered properties**:

```text
10,800 / 9,985 = 1.08162 BINs/property
20,000 properties -> ~21,632 BINs

ceil(21,632 / 1,000)
= 22 data batches

22 data-page calls
+ 2 metadata calls
= ~24 baseline Socrata calls

81,486 / 9,985 * 20,000 = ~163,217 rows
1,311.004 / 9,985 * 20,000 = ~2,625.947 s (~43m 46s)
```

These are estimates, not measured 20,000-property results. Property mix, shared BINs, pagination, latency, and retries can change them.

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

At the final acceptance scale:

```text
10,000 PLUTO BBL inputs
-> 9,985 registered properties
-> 10,800 unique valid BINs
-> 11 ECB data-page requests
-> +2 metadata requests
-> +1 observed retry
-> 14 observed Socrata requests
```

For 20,000 successfully registered properties, the same measured BIN/property ratio gives a planning estimate of **~21,632 BINs** and **~24 baseline Socrata calls** before retries/additional pages.

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

At 20,000 properties, ECB remains comfortably in watchlist territory based on the measured/projection call counts and relevant-row volume.

For **one versus ten NYC data points**, ten hypothetical ECB-shaped sources at the 20k estimate would be roughly **240 baseline calls, 1.63M relevant rows, and 7h 18m of serial ingestion**. This is an illustrative reference only: real datasets differ in density, update frequency, queryability, identifiers, payload size, and historical depth.

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
