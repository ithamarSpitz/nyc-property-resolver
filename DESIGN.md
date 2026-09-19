# Design

## Strategy and scale

The implemented strategy is a **BIN-keyed watchlist pull**. A property is resolved once, its canonical BBL and valid BINs are stored, and later ECB runs scan the deduplicated BIN set in bounded batches. Query endpoints read PostgreSQL only, so production reads never depend on Socrata.

I rejected a citywide ECB mirror for the first data point. The source has roughly 1.8 million rows, while the product requirement is a tracked portfolio. At the measured portfolio scale, watchlist ingestion transfers only relevant rows and avoids the storage, incremental-delete handling, and operational surface of mirroring unrelated citywide data.

The deterministic scale run submitted **10,000 PLUTO BBLs**. Fifteen source/resolver-quality cases failed registration, leaving **9,985 registered properties** and **10,800 valid BINs**. The accepted ingestion completed with:

```text
11 data calls + 2 metadata calls + 1 retry = 14 Socrata calls
81,486 rows fetched/staged/promoted
0 ingestion failures
1,311.004 s ingestion
1,651.394 s end to end
```

Using the measured ratios as a linear planning estimate for **20,000 successfully registered properties**:

```text
10,800 / 9,985 = 1.08162 BINs/property
20,000 properties -> ~21,632 BINs
ceil(21,632 / 1,000) = 22 data calls
22 data calls + 2 metadata calls = ~24 baseline calls

81,486 / 9,985 * 20,000 = ~163,217 rows
1,311.004 / 9,985 * 20,000 = ~2,625.947 s (~43m 46s)
```

These are estimates, not measured 20k results; density, shared BINs, pagination, latency, and retries can change them.

For **one versus ten NYC data points**, ten hypothetical ECB-shaped sources at the 20k estimate would be roughly **240 baseline calls, 1.63M relevant rows, and 7h 18m of serial ingestion**. That is only a reference point: real datasets differ in density, identifiers, history, update rate, and query support. I would reconsider mirroring per source when watchlist refresh cost approaches an incremental citywide copy, source-side identifier filtering becomes inefficient, tracked properties cover a substantial share of relevant rows, or the product requires untracked/citywide queries.

## Storage and idempotency

PostgreSQL is the system of record.

- `properties` is unique by canonical 10-digit BBL; `property_resolution_inputs` makes normalized address/BBL registration idempotent; `property_bins` stores the valid BIN set.
- `ecb_violation_raw` preserves upstream observations and provenance, including fetch time and source update time, so normalized data can be re-derived after parser fixes.
- `ecb_violation_staging` holds run-scoped normalized candidates and is never served.
- `ecb_violations` is the last accepted live state, unique by durable source ID.
- `ingestion_runs`, immutable run BIN snapshots, and immutable batches persist resumable execution state; `property_dataset_coverage` stores property-level freshness and coverage.

Database uniqueness and upserts make replay safe. Raw is stored before strict normalization, while live normalized state is changed only by an accepted run.

## Resume, partial failure, freshness, and coverage

At run start, the worker snapshots Property↔BIN associations and partitions the deduplicated BIN set into immutable batches. Resume reloads those definitions and skips completed batches instead of rebuilding the watchlist. A crashed partial batch safely restarts at page one because raw/staging writes are idempotent.

Execution is explicitly bounded: 1,000 BINs per batch, 50,000 rows per page, at most 100 pages per batch, concurrency 10, a 15 s request timeout, 3 HTTP retries, and 3 logical attempts per batch in the measured configuration.

Each run records the Socrata dataset watermark before and after scanning. Live publication occurs only when all batches succeed and the watermark is stable. `FAILED` or `SOURCE_CHANGED` runs do not promote staging or perform negative reconciliation, so partial work cannot create a hybrid live view.

Coverage is explicit rather than inferred from row count:

- `CHECKED` can accompany an empty result and records the last successful attempt/watermark.
- `NOT_CHECKED` records reasons such as `NEVER_INGESTED`, `NO_VALID_BIN`, or changed identifiers.
- `FAILED` records when and why the latest property-scoped attempt failed while preserving any previous successful freshness.

Coverage publication is guarded by the property's identifier version, so an older run cannot certify a BIN set that changed after its snapshot.

## Next and first refactor

Next I would add a second concrete source, such as HPD Violations, behind its own endpoint and then emit change alerts between accepted runs.

Only after that second source proves the common shape would I extract shared ingestion infrastructure: run lifecycle, locking, immutable batching, bounds, metrics, and coverage handling. Source querying, identity, parsing, and normalization should remain dataset-specific adapters rather than forcing a generic framework before a second real example exists.

Detailed resolver and ingestion mechanics are documented in [`ARCHITECTURE.md`](ARCHITECTURE.md); measured runs and evidence are indexed in [`RUN_LOG.md`](RUN_LOG.md). Additional implementation details intentionally omitted here are preserved in [`WALKTHROUGH.md`](WALKTHROUGH.md).
