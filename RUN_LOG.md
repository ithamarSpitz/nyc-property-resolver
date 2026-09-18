# Acceptance Run Log

This is an index and readable summary; the linked JSON and logs are the evidence of record. Times are UTC.

## Small five-property acceptance — 2026-09-17

Seed: [`seed/acceptance-properties.json`](seed/acceptance-properties.json). Registration requests and responses are preserved in [`requests-responses.json`](evidence/acceptance-small/run/registration/requests-responses.json). The five inputs resolved to six valid BINs.

Both runs used:

```bash
docker compose run --rm worker npm run ingest:ecb
```

### Baseline

- Run ID: `796d778e-f98f-4ceb-813d-801e3091f10c`
- Status/outcome: `COMPLETED`
- Evidence interval: `2026-09-17T12:40:25.385Z`–`12:40:37.078Z` (11.693 s); worker-reported ingestion duration: 7.086 s
- Counts: 6 BINs; 1 data call + 2 metadata calls + 0 retries = 3 total; 297 rows fetched/written; 0 failures
- Source watermark: `2026-09-16T16:59:26.000Z`
- Records: [`run.json`](evidence/acceptance-small/run/baseline/run.json), [`command.json`](evidence/acceptance-small/run/baseline/command.json), [`ingestion.log`](evidence/acceptance-small/run/baseline/ingestion.log), and captured [`property API`](evidence/acceptance-small/run/baseline/api/properties.json) / [`portfolio API`](evidence/acceptance-small/run/baseline/api/portfolio.json) responses

### Immediate idempotent run

- Run ID: `ae44eea8-af81-4258-8936-8719bbf7ba7c`
- Status/outcome: `COMPLETED`
- Evidence interval: `2026-09-17T12:40:37.255Z`–`12:40:47.692Z` (10.437 s); worker-reported ingestion duration: 5.202 s
- Counts: 6 BINs; 1 data call + 2 metadata calls + 0 retries = 3 total; 297 rows fetched/written; 0 failures
- Source watermark: unchanged at `2026-09-16T16:59:26.000Z`
- Records: [`run.json`](evidence/acceptance-small/run/second-run/run.json), [`command.json`](evidence/acceptance-small/run/second-run/command.json), and [`ingestion.log`](evidence/acceptance-small/run/second-run/ingestion.log)

The [`duplicate audit`](evidence/acceptance-small/run/duplicate-audit.json) found baseline and second-run counts unchanged at 297 property-result rows, 297 portfolio rows, and 297 unique source IDs; both snapshots had zero duplicate source IDs and every delta was zero. `idempotentNoDuplicateGrowth` was `true`.

The source-identity probe is preserved in [`result.json`](evidence/acceptance-small/run/source-contract/result.json): 1,835,399 total rows, the same number of distinct `ISN_DOB_BIS_EXTRACT` values, zero nulls, and no duplicate groups.

### BIS comparison

The exact structured comparisons and retrieval timestamps are in [`spot-checks.json`](evidence/acceptance-small/run/bis/spot-checks.json) and [`retrieval-log.json`](evidence/acceptance-small/run/bis/retrieval-log.json); downloaded text records are under [`property-profile/`](evidence/acceptance-small/run/bis/property-profile/).

- Empire State Building, BIN `1015862`: local total 241; BIS “Violations–OATH/ECB Total” 241; match.
- 37-15 82nd Street, BIN `4036223`: local total 10; BIS total 10; match.
- 22-01 Steinway Street, BIN `4015377`: local BBL/block/lot/address and single-BIN identity matched the BIS profile (this third check validated identity, not a count).

## Deterministic PLUTO 10,000-BBL sample — 2026-09-18

Definition: [`seed/scale-10000-bbls.json`](seed/scale-10000-bbls.json) stores the first 10,000 unique canonical BBLs in ascending order from live PLUTO dataset `64uk-42ks`, community districts 102 and 108, without pre-screening for downstream resolver success. The runner submitted 50 API requests of 200 BBLs each to `POST /properties/bulk`.

Commands captured by the final run:

```bash
docker compose -p nyc-s5-t12-scale down --volumes --remove-orphans
docker compose -p nyc-s5-t12-scale up -d --build postgres api
docker compose -p nyc-s5-t12-scale run --rm worker npm run ingest:ecb
```

Final measured results from [`summary.json`](evidence/scale-10000/summary.json):

| Metric | Result |
| --- | ---: |
| Overall evidence interval | `2026-09-18T19:25:42.924Z`–`19:53:14.318Z` |
| Total wall time | 1,651.394 s (27m 31.394s) |
| Registration wall time | 310.500 s (5m 10.500s) |
| Requested / unique BBLs | 10,000 / 10,000 |
| Registered unique properties | 9,985 |
| Registration failures | 15 |
| Ingestion run ID | `ed2f5447-d250-41a9-9caf-53cc0b730825` |
| Ingestion status/outcome | `COMPLETED` / `COMPLETED` |
| Ingestion wall time | 1,311.004 s (21m 51.004s) |
| Unique valid BINs | 10,800 |
| Persisted batches | 11 |
| Socrata data-page calls | 11 |
| Socrata metadata calls | 2 |
| Socrata retry calls | 1 |
| Socrata total calls | 14 (`11 + 2 + 1`) |
| Rows fetched / staged / promoted | 81,486 / 81,486 / 81,486 |
| Ingestion failures | 0 |
| Start/end source watermark | `2026-09-18T16:58:46+00:00` / same |

Raw records: [`worker.log`](evidence/scale-10000/worker.log), [`database-run.json`](evidence/scale-10000/database-run.json), [`bulk-registration.json`](evidence/scale-10000/bulk-registration.json), and [`api.log`](evidence/scale-10000/api.log).

### Retries and failures, without omission

The successful ingestion needed one transient Socrata retry; the source watermark remained stable and all 11 batches completed, so it promoted with zero ingestion failures. Bulk registration accepted 9,985 properties and reported 15 per-BBL failures: 14 `RESOLVER_PLUTO_INCOMPLETE` (`missing_address`) and one `RESOLVER_FOOTPRINT_MAPPLUTO_BBL_MISMATCH`. The full per-input records are retained in `bulk-registration.json`.

Earlier diagnostic attempts are retained under [`evidence/scale-10000/diagnostics/`](evidence/scale-10000/diagnostics/): attempt 01 exposed HTTP 414 from an oversized bulk source query; attempt 02 exposed the incorrect expectation that every selected BBL must register; attempt 03 audited the 15 live-source cases; attempt 04 completed ingestion but was marked invalid by the then-exact-10,000 persistence criterion. The final evidence uses bounded 200-BBL API chunks and reports both the 10,000-BBL input cohort and the 9,985-property ingested watchlist explicitly.

Both small-run worker logs and the final scale logs also contain Prisma's OpenSSL-detection warning. It did not prevent migration, ingestion, publication, or a zero exit code, but it is retained in the raw logs rather than removed.
