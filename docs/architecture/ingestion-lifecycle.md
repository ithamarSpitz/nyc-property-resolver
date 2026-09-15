<!-- GENERATED CONTEXT MODULE. Source of truth: /ARCHITECTURE.md. -->
<!-- Do not edit independently; regenerate from the final architecture if it changes. -->

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
