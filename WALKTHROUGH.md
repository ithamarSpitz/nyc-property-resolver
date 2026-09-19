# Operational Walkthrough

This file keeps the runnable, platform-specific details and acceptance notes intentionally omitted from the concise `README.md`.

## Startup and configuration details

From a clean checkout, the same startup command works in Linux/macOS (Bash/zsh or an equivalent POSIX shell) and Windows PowerShell:

```text
docker compose up --build
```

Compose waits for PostgreSQL health, runs `prisma migrate deploy` once, then starts the API on `http://localhost:3000` and the ingestion worker. The worker runs immediately and then weekly by default (`604800000` ms).

Configuration is read from environment variables. Copy `.env.example` to an untracked `.env` and set only the overrides you need. `SOCRATA_APP_TOKEN` is optional and raises Socrata limits; never commit the token or `.env`. Other bounded ingestion controls are documented in `.env.example`.

Trigger exactly one ingestion run without waiting for the scheduler:

```text
docker compose run --rm worker npm run ingest:ecb
```

## Copy-paste API commands

All responses are JSON. Replace `<property-id>` and `<cursor>` with values returned by earlier calls. Linux/macOS examples target Bash/zsh. Windows examples target Windows PowerShell. For JSON request bodies, PowerShell 5.1 uses `Invoke-RestMethod` because JSON passed to `curl.exe` can be mangled.

### Create or resolve a property

Exactly one of `address` or `bbl` is accepted; repeated input is idempotent.

Linux/macOS:

```bash
curl -sS -X POST http://localhost:3000/properties \
  -H 'content-type: application/json' \
  -d '{"address":"350 5th Avenue, Manhattan, NY"}'
```

Windows PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/properties" `
  -ContentType "application/json" `
  -Body '{"address":"350 5th Avenue, Manhattan, NY"}'
```

### Get the stored property

Linux/macOS:

```bash
curl -sS http://localhost:3000/properties/<property-id>
```

Windows PowerShell:

```powershell
curl.exe -sS "http://localhost:3000/properties/<property-id>"
```

### Get locally stored ECB rows for one property

Results are newest first. `openOnly=true`, `unpaidOnly=true`, `limit=1..100`, and the opaque `cursor` are optional.

Linux/macOS:

```bash
curl -sS 'http://localhost:3000/properties/<property-id>/ecb-violations?openOnly=false&unpaidOnly=false&limit=1'
```

Windows PowerShell:

```powershell
curl.exe -sS "http://localhost:3000/properties/<property-id>/ecb-violations?openOnly=false&unpaidOnly=false&limit=1"
```

### Register BBLs in bulk

The endpoint accepts 1–10,000 BBLs per request. Results are reported per input so source-data failures remain visible.

Linux/macOS:

```bash
curl -sS -X POST http://localhost:3000/properties/bulk \
  -H 'content-type: application/json' \
  -d '{"bbls":["1008350041"]}'
```

Windows PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/properties/bulk" `
  -ContentType "application/json" `
  -Body '{"bbls":["1008350041"]}'
```

### Scan current ECB results across watched properties

`unpaidOnly=true`, `updatedSince=<ISO timestamp>`, `limit=1..100`, and the returned cursor are optional. This endpoint returns current accepted violations only; per-property freshness and coverage are exposed by `GET /properties/<property-id>/ecb-violations`.

Linux/macOS:

```bash
curl -sS 'http://localhost:3000/ecb-violations?unpaidOnly=true&limit=1'
```

Windows PowerShell:

```powershell
curl.exe -sS "http://localhost:3000/ecb-violations?unpaidOnly=true&limit=1"
```

## Coverage semantics

Coverage is independent of the result count:

- `CHECKED` plus `violations: []` means the accepted run scanned every snapshotted BIN and found nothing. `lastSuccessAt` and `sourceWatermarkAt` describe freshness.
- `NOT_CHECKED` means no accepted property-scoped scan yet. `statusReason` distinguishes `NEVER_INGESTED`, `NO_VALID_BIN`, or identifier changes; timestamps can be null.
- `FAILED` means the latest property-scoped attempt failed. `lastAttemptAt` and `lastError` explain when and why, while any prior `lastSuccessAt` and `sourceWatermarkAt` still describe the live rows.

## Recorded walkthrough and acceptance evidence

The representative manual-trigger record below is for the full five-property acceptance seed: 6 BINs and 297 rows.

```json
{"outcome":"COMPLETED","runId":"796d778e-f98f-4ceb-813d-801e3091f10c","status":"COMPLETED","binsScanned":6,"socrataDataCalls":1,"socrataMetadataCalls":2,"socrataRetryCalls":0,"socrataTotalCalls":3,"rowsFetched":297,"rowsWritten":297,"failures":0,"durationMs":7086}
```

For a deterministic Empire State walkthrough: start Compose, `POST /properties` with `350 5th Avenue, Manhattan, NY`, copy the returned ID, run the manual ingestion command, then call `GET /properties/<id>/ecb-violations?limit=100`. In the recorded acceptance run it resolved to BBL `1008350041` / BIN `1015862`, returned 241 locally stored rows across three pages, and reported `CHECKED` coverage.

The five-property fixture is `seed/acceptance-properties.json`; it includes the Empire State Building, a Queens hyphenated number, a condo unit, a two-family house, and an unpaid-balance property.

With the API running, Node 22 is needed only for the optional evidence runner:

```text
npm run acceptance:small
```

It writes a new timestamped evidence directory, registers the seed, performs two manual runs, and audits duplicates; BIS checks remain manual. The committed run is indexed in `RUN_LOG.md`.

On 2026-09-17, BIS and local totals matched for Empire State (241 vs 241) and 37-15 82nd Street (10 vs 10), as recorded in `evidence/acceptance-small/run/bis/spot-checks.json`.

The deterministic 10,000-BBL PLUTO sample submitted all 10,000 source BBLs. It yielded 9,985 registered properties and 10,800 valid BINs; the 15 source/resolver-quality failures were retained rather than pre-filtered. Accepted ingestion completed in 1,311.004 s, made 14 Socrata calls including one retry, promoted 81,486 rows, and had zero ingestion failures. Full scale evidence is indexed in `RUN_LOG.md` and `evidence/scale-10000/summary.json`.

## Resolver-source detail

Address resolution uses GeoSearch for address-to-parcel candidates, PLUTO for canonical parcel attributes, the Condominium Units/Condominiums datasets for unit-to-building mapping, and Building Footprints for validated BINs. This split keeps each source in the role where it is strongest: GeoSearch resolves free-text address candidates, PLUTO anchors parcel identity, the condo datasets bridge unit lots to the building parcel, and Building Footprints provides building-level BIN validation, including multi-building lots. ECB scans then use those stored BINs in batches.


## Additional design details preserved from the original DESIGN.md

The concise `DESIGN.md` keeps the assignment-required decisions and arithmetic. The details below preserve implementation notes that were intentionally removed from that shorter document.

### Scale evidence details

The final scale evidence selected the first 10,000 unique canonical BBLs, ordered by BBL, from PLUTO community districts 102 and 108. The 15 registration failures were kept visible rather than filtering the input cohort to force 10,000 successes.

Additional measured values from the accepted run:

```text
9,985 properties -> 10,800 unique valid BINs -> 11 persisted batches
registration: 310.500 s
ingestion: 1,311.004 s (21m 51.004s)
end to end: 1,651.394 s (27m 31.394s)
```

These figures come from `evidence/scale-10000/summary.json`, not from the earlier planning probe.

The watchlist-versus-mirror decision should ultimately be based on measured calls, bytes, wall time, storage, and reliability rather than data-point count alone. Cross-portfolio change detection that materially benefits from citywide local state is another reason to reconsider a mirror/CDC-style design.

### Exact storage keys and accepted-state rules

The storage model uses these concrete keys and boundaries:

- `properties` is unique by 10-digit BBL.
- `property_resolution_inputs` is unique by `(input_type, normalized_input)`, so the same normalized input reuses its existing property mapping.
- `property_bins` is keyed by `(property_id, bin)` and contains valid, non-placeholder BINs.
- `ecb_violation_raw` stores semantically equivalent upstream JSON plus `fetched_at`, first-run provenance, Socrata row ID, and source update time. `(source_id, source_row_updated_at)` retains one copy of each observed upstream version.
- `ecb_violation_staging` is run-scoped and unique by `(run_id, source_id)`; it is never served.
- `ecb_violations` is the last accepted live state, unique by `source_id`. `is_current` records source-current state for scanned BINs, while portfolio membership is constrained separately through current `property_bins`.
- `ingestion_runs`, `ingestion_run_property_bins`, and `ingestion_batches` persist execution state. The run BIN snapshot and batches are immutable.
- `property_dataset_coverage` is keyed by `(property_id, dataset)`.

For ECB, the durable upstream identity is `ISN_DOB_BIS_EXTRACT`; Socrata `:id` and `:updated_at` are retained separately. The acceptance source-contract probe found 1,835,399 rows, the same number of distinct non-null `ISN_DOB_BIS_EXTRACT` values, zero nulls, and no duplicate groups. The immediate second small run preserved 297 logical rows with zero duplicate source IDs.

Raw positive observations alone cannot prove that an upstream row was deleted. Source-current state is changed only during accepted promotion and negative reconciliation.

### Run initialization and resume details

Run initialization is atomic: one transaction snapshots Property↔BIN associations together with each property's `identifier_version`, partitions distinct BINs into immutable batch definitions, and commits that execution plan.

A resumed run loads those persisted definitions, skips completed batches, and does not reload or repartition the live watchlist. If a batch crashes partway through pagination, it restarts safely at page one because raw/staging uniqueness makes replay idempotent. This intentionally avoids treating a Socrata OFFSET as a durable resume cursor.

If the configured page limit or logical-attempt limit is exhausted, the batch fails and publication is blocked.

### Advisory-lock ownership

A dedicated `pg` session holds the dataset advisory lock. The database session—not merely the process and not a surviving Prisma pool—is the execution authority.

A second manual or scheduled executor reports the active owner rather than performing concurrent state-changing ingestion. If the lock-owning connection is lost, authority is revoked immediately and no further state-changing ingestion work should continue under that run.

### Publication and SOURCE_CHANGED details

Each run reads the Socrata dataset watermark before and after scanning. When all batches succeed and the best-effort watermark is unchanged, one short transaction:

1. upserts staging into the live table;
2. marks rows missing from every fully scanned BIN as non-current;
3. writes successful property coverage; and
4. marks the run `COMPLETED`.

`FAILED` and `SOURCE_CHANGED` runs never promote staging and never perform negative reconciliation, so partial candidates cannot create a hybrid live view.

`SOURCE_CHANGED` means the observable upstream watermark changed during the scan. The next run starts fresh instead of reusing persisted batches against a different source baseline. Raw/staging records may remain for audit, while live rows and `last_success_*` still describe the previously accepted run.

### Coverage snapshot/version guards

Coverage is computed from the immutable run snapshot rather than from whatever property identifiers happen to be current at publication time.

Successful and failed coverage updates are applied only when the live `properties.identifier_version` still equals the version captured in the run snapshot. This prevents an older run from certifying or failing a newer BIN set.

A failure that occurs before the Property↔BIN snapshot commits is run-level only; it does not falsely mark every property as `FAILED`.
