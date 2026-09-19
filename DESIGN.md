# Design

## Resolve once; pull the watchlist

The implemented strategy is a BIN-keyed watchlist pull. Address/BBL registration resolves a property once, persists its BBL and valid BIN set, and later ECB runs scan the deduplicated BINs in bounded batches. Query endpoints read PostgreSQL only. This separates slow, fallible NYC source access from customer-facing reads and avoids one Socrata call per property.

The alternative was a citywide ECB mirror. It simplifies arbitrary citywide queries, but the product requirement is a tracked portfolio and the source contains roughly 1.8 million rows. At the measured portfolio scale, a watchlist pull stores and transfers only relevant rows with 11 data-page calls. Mirroring unrelated rows adds storage, transfer, incremental-delete logic, and operational surface without improving the required request path, so it was rejected for this first data point.

## Measured scale and 20k planning arithmetic

The final scale evidence selected the first 10,000 unique canonical BBLs, ordered by BBL, from PLUTO community districts 102 and 108. Fifteen source/resolver-quality cases failed registration, leaving **9,985 measured properties**; this is intentionally not rounded up to 10,000. Those properties produced:

```text
9,985 properties -> 10,800 unique valid BINs -> 11 persisted batches
11 data calls + 2 metadata calls + 1 retry = 14 total Socrata calls
81,486 fetched/staged/promoted rows; 0 ingestion failures
registration: 310.500 s
ingestion: 1,311.004 s (21m 51.004s)
end to end: 1,651.394 s (27m 31.394s)
```

These are measured results from `evidence/scale-10000/summary.json`, not the earlier planning probe.

For a clearly labelled **linear 20,000-successfully-registered-property extrapolation**, using this sample's measured ratios and the same 1,000-BIN batch size:

```text
10,800 / 9,985 = 1.08162 BINs/property
20,000 * 1.08162 = ~21,632 BINs
ceil(21,632 / 1,000) = 22 data-page calls
22 data calls + 2 metadata calls = ~24 baseline calls, before retries/extra pages

81,486 / 9,985 = 8.16084 rows/property
20,000 * 8.16084 = ~163,217 rows

1,311.004 s / 9,985 * 20,000 = ~2,625.947 s (~43m 46s) ingestion
```

The row and time figures are capacity estimates, not measured 20k results; source density, shared/multi-building BINs, latency, pagination, and retries can change them.

With one NYC data point, watchlist cost is comfortably bounded. As a reference point only, ten hypothetical ECB-like sources at 20,000 properties would imply roughly **240 baseline Socrata calls, 1.63M relevant rows, and 7h 18m of serial ingestion** at the measured linear rate. That is not a forecast for ten real datasets: each source has different density, identifiers, history, update rate, and query support, so the strategy is revisited per source. Evidence that would trigger a mirror/CDC-style redesign includes watchlist transfer or refresh time approaching an incremental citywide copy, tracked properties covering a substantial fraction of relevant rows, inefficient/unavailable source-side identifier filtering, requirements for untracked properties, or cross-portfolio change detection that materially benefits from a citywide local state. The decision inputs are measured calls, bytes, wall time, storage, and reliability—not data-point count alone.

## Storage, identity, and accepted state

PostgreSQL is the system of record:

- `properties` is unique by 10-digit BBL; `property_resolution_inputs` is unique by `(input_type, normalized_input)` so the same normalized request reuses its mapping. `property_bins` is keyed by `(property_id, bin)` and contains valid, non-placeholder BINs.
- `ecb_violation_raw` preserves semantically equivalent upstream JSON plus `fetched_at`, first run, Socrata row ID, and source update time. `(source_id, source_row_updated_at)` retains one copy of each observed upstream version.
- `ecb_violation_staging` is run-scoped candidate state, unique by `(run_id, source_id)`. It is never served.
- `ecb_violations` is the last accepted live state, unique by `source_id`; `is_current` records source-current state for scanned BINs. Portfolio membership is separately constrained through current `property_bins`.
- `ingestion_runs`, immutable `ingestion_run_property_bins`, and immutable `ingestion_batches` hold durable execution state. `property_dataset_coverage` is keyed by `(property_id, dataset)`.

For ECB, durable source identity is `ISN_DOB_BIS_EXTRACT`; `:id` and `:updated_at` are retained separately. The acceptance probe found 1,835,399 rows, 1,835,399 distinct non-null source IDs, and no duplicate groups. Database uniqueness and upserts make replay safe; the second small run preserved 297 logical rows with zero duplicate source IDs.

Raw is written before strict domain normalization, so parser fixes can re-derive normalized source fields. Raw positive observations cannot by themselves prove deletion: currentness is established only by accepted promotion and negative reconciliation.

## Durable, bounded execution and ownership

A new run transaction snapshots Property↔BIN associations with each property's `identifier_version`, partitions distinct BINs into immutable batch definitions, and commits initialization atomically. Resume loads those persisted definitions, skips completed batches, and never reloads or repartitions the live watchlist. A crashed partial batch restarts at page one; raw/staging uniqueness makes replay safe, while avoiding an unsafe durable Socrata OFFSET cursor.

Every dimension is bounded: batch size 1,000, page size 50,000, at most 100 pages per batch, concurrency 10, 15 s request timeout, 3 HTTP retries, and 3 logical attempts per batch in the measured configuration. Page-limit or attempt exhaustion fails the batch and prevents publication.

A dedicated `pg` session holds the dataset advisory lock. That session—not the process or a surviving Prisma pool—is execution authority. A second manual/scheduled executor reports the active owner, and loss of the lock connection revokes permission immediately so no further state-changing ingestion work continues.

## Publication, failures, and freshness

Each run observes the Socrata dataset watermark before and after scanning. If all batches succeed and the best-effort watermark is unchanged, one short transaction upserts staging into live, marks rows missing from every fully scanned BIN non-current, writes successful coverage, and marks the run `COMPLETED`.

`FAILED` and `SOURCE_CHANGED` runs never promote staging or run negative reconciliation, so partial candidates cannot create a hybrid live view. `SOURCE_CHANGED` means the observable upstream watermark moved during the scan; the next run starts fresh rather than reusing batches against a different source baseline. Raw/staging may remain for audit, while live rows and `last_success_*` continue to describe the same previously accepted run.

Coverage is explicit, not inferred from row existence. `CHECKED` can accompany an empty list; `NOT_CHECKED` carries reasons such as `NEVER_INGESTED`, `NO_VALID_BIN`, or invalidated identifiers; `FAILED` records the latest scoped attempt while retaining the prior success. Coverage is computed from the immutable run snapshot only. Successful or failed updates apply only if the live `identifier_version` still equals the captured version, preventing an old run from certifying a changed BIN set. A failure before the snapshot commits is run-level only and does not falsely mark every property failed.

## Next

Next, add a second concrete source such as HPD violations behind its own endpoint, then emit change alerts from differences between accepted runs. Only after that second source proves the common shape should the first refactor extract shared run lifecycle, locking, immutable batching, bounds, metrics, and coverage infrastructure. Source querying, identity, parsing, and normalization should remain dataset-specific adapters; creating a generic framework before a second example would encode guesses rather than demonstrated reuse.
