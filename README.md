# NYC Property Resolver and DOB ECB Pipeline

This service resolves NYC addresses or BBLs once, stores canonical parcel/building identifiers in PostgreSQL, refreshes DOB ECB violations on a schedule, and serves queries entirely from the local database. Property registration may call NYC resolution sources; stored-property and ECB query requests never call Socrata.

## Run it

The application path requires only Docker with Compose. From a clean checkout, run this command in either Linux / macOS (Bash/zsh or an equivalent POSIX shell) or Windows PowerShell.

**Cross-platform (Linux / macOS and Windows PowerShell):**

```text
docker compose up --build
```

Compose waits for PostgreSQL health, runs `prisma migrate deploy` once, then starts the API on `http://localhost:3000` and the ingestion worker. The worker runs immediately and then weekly by default.

Configuration is read from environment variables. Copy `.env.example` to an untracked `.env` and set only the overrides you need:

```env
# 24 hours instead of the default 604800000 ms (weekly)
INGEST_INTERVAL_MS=86400000

# Optional: raises Socrata limits; never commit the token or .env
SOCRATA_APP_TOKEN=your-token-here
```

Other bounded ingestion controls are documented in `.env.example`. Trigger exactly one ingestion run without waiting for the scheduler:

**Cross-platform (Linux / macOS and Windows PowerShell):**

```text
docker compose run --rm worker npm run ingest:ecb
```

Address resolution uses GeoSearch for address-to-parcel candidates, PLUTO for canonical parcel attributes, the Condominium Units/Condominiums datasets for unit-to-building mapping, and Building Footprints for validated BINs. ECB scans then use those stored BINs in batches.

This split keeps each source in the role where it is strongest: GeoSearch resolves free-text address candidates, PLUTO anchors parcel identity, the condo datasets bridge unit lots to the building parcel, and Building Footprints provides building-level BIN validation, including multi-building lots.

## API by example

All responses are JSON. Replace `<property-id>` and `<cursor>` with values returned by the preceding call. Linux / macOS examples target Bash/zsh (or an equivalent POSIX shell). Windows examples target Windows PowerShell. For JSON request bodies, the PowerShell examples use `Invoke-RestMethod` because PowerShell 5.1 can mangle JSON passed to `curl.exe`.

Create or resolve one property (exactly one of `address` or `bbl`; repeated input is idempotent):

**Linux / macOS — Bash/zsh (POSIX shell):**

```bash
curl -sS -X POST http://localhost:3000/properties \
  -H 'content-type: application/json' \
  -d '{"address":"350 5th Avenue, Manhattan, NY"}'
```

**Windows PowerShell:**

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/properties" `
  -ContentType "application/json" `
  -Body '{"address":"350 5th Avenue, Manhattan, NY"}'
```

```json
{"id":"21f0f802-96f9-4ce3-b6dd-8e5b54dc2556","identifierVersion":1,"bbl":"1008350041","condoBaseBbl":null,"condoBillingBbl":null,"normalizedAddress":"350 5th Avenue, Manhattan, Ny","borough":1,"block":835,"lot":41,"bins":["1015862"],"createdAt":"2026-09-17T12:40:19.561Z","resolvedAt":"2026-09-17T12:40:19.558Z"}
```

Get the stored property:

**Linux / macOS — Bash/zsh (POSIX shell):**

```bash
curl -sS http://localhost:3000/properties/<property-id>
```

**Windows PowerShell:**

```powershell
curl.exe -sS "http://localhost:3000/properties/<property-id>"
```

```json
{"id":"21f0f802-96f9-4ce3-b6dd-8e5b54dc2556","identifierVersion":1,"bbl":"1008350041","condoBaseBbl":null,"condoBillingBbl":null,"normalizedAddress":"350 5th Avenue, Manhattan, Ny","borough":1,"block":835,"lot":41,"bins":["1015862"],"createdAt":"2026-09-17T12:40:19.561Z","resolvedAt":"2026-09-17T12:40:19.558Z"}
```

Get that property's locally stored ECB rows. Results are newest first; `openOnly=true`, `unpaidOnly=true`, `limit=1..100`, and the opaque `cursor` are optional:

**Linux / macOS — Bash/zsh (POSIX shell):**

```bash
curl -sS 'http://localhost:3000/properties/<property-id>/ecb-violations?openOnly=false&unpaidOnly=false&limit=1'
```

**Windows PowerShell:**

```powershell
curl.exe -sS "http://localhost:3000/properties/<property-id>/ecb-violations?openOnly=false&unpaidOnly=false&limit=1"
```

```json
{"violations":[{"sourceId":"1572407","bin":"1015862","violationNumber":"39107427M","issueDate":"2024-03-01","ecbViolationStatus":"RESOLVE","balanceDue":"0","sourceRowUpdatedAt":"2025-10-20T17:02:25.556Z"}],"coverage":{"status":"CHECKED","statusReason":null,"lastAttemptAt":"2026-09-17T12:40:36.464Z","lastSuccessAt":"2026-09-17T12:40:36.464Z","sourceWatermarkAt":"2026-09-16T16:59:26.000Z","lastError":null},"page":{"limit":1,"hasMore":true,"nextCursor":"<cursor>"}}
```

Register BBLs in bulk (1–10,000 per request; results are per input so source-data failures remain visible):

**Linux / macOS — Bash/zsh (POSIX shell):**

```bash
curl -sS -X POST http://localhost:3000/properties/bulk \
  -H 'content-type: application/json' \
  -d '{"bbls":["1008350041"]}'
```

**Windows PowerShell:**

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/properties/bulk" `
  -ContentType "application/json" `
  -Body '{"bbls":["1008350041"]}'
```

```json
{"summary":{"submitted":1,"unique":1,"succeeded":1,"failed":0,"cached":0},"results":[{"inputBbl":"1008350041","canonicalBbl":"1008350041","status":"succeeded","property":{"id":"21f0f802-96f9-4ce3-b6dd-8e5b54dc2556","bbl":"1008350041","borough":1,"block":835,"lot":41,"normalizedAddress":"350 5th Avenue, Manhattan, Ny","condoBaseBbl":null,"condoBillingBbl":null,"identifierVersion":1,"bins":["1015862"],"coverage":[{"dataset":"DOB_ECB_VIOLATIONS","status":"NOT_CHECKED","statusReason":"NEVER_INGESTED"}]}}]}
```

Scan current ECB results across all watched properties without one request per property. `unpaidOnly=true`, `updatedSince=<ISO timestamp>`, `limit=1..100`, and the returned cursor are optional:

**Linux / macOS — Bash/zsh (POSIX shell):**

```bash
curl -sS 'http://localhost:3000/ecb-violations?unpaidOnly=true&limit=1'
```

**Windows PowerShell:**

```powershell
curl.exe -sS "http://localhost:3000/ecb-violations?unpaidOnly=true&limit=1"
```

```json
{"violations":[{"id":"af7ca7d3-bb39-4d73-aa3f-8735bfe9b936","sourceId":"1671991","socrataRowId":"row-atgj~8tec~94sg","bin":"4015377","violationNumber":"39195205J","issueDate":"2026-07-08","ecbViolationStatus":"ACTIVE","balanceDue":"6250.00","sourceRowUpdatedAt":"2026-09-16T16:59:22.394Z","lastSuccessRunId":"796d778e-f98f-4ceb-813d-801e3091f10c","isCurrent":true}],"page":{"limit":1,"hasMore":true,"nextCursor":"<cursor>"}}
```

The manual trigger is the CLI command above. The representative record below is for the full five-property acceptance seed (6 BINs, 297 rows); the Empire State walkthrough below is scoped to that single property (241 rows).

```json
{"outcome":"COMPLETED","runId":"796d778e-f98f-4ceb-813d-801e3091f10c","status":"COMPLETED","binsScanned":6,"socrataDataCalls":1,"socrataMetadataCalls":2,"socrataRetryCalls":0,"socrataTotalCalls":3,"rowsFetched":297,"rowsWritten":297,"failures":0,"durationMs":7086}
```

## Coverage, seed, and walkthrough

Coverage is independent of the result count:

- `CHECKED` plus `violations: []` means the accepted run scanned every snapshotted BIN and found nothing. `lastSuccessAt` and `sourceWatermarkAt` say how fresh that conclusion is.
- `NOT_CHECKED` means no accepted property-scoped scan yet. `statusReason` distinguishes `NEVER_INGESTED`, `NO_VALID_BIN`, or identifier changes; timestamps can be null.
- `FAILED` means the latest property-scoped attempt failed. `lastAttemptAt` and `lastError` explain when/why, while prior `lastSuccessAt` and `sourceWatermarkAt` remain available and still describe the live rows.

Deterministic Empire State walkthrough: start Compose, `POST /properties` with the address above, copy its returned `id`, run the manual ingestion command, then call `GET /properties/<id>/ecb-violations?limit=100`. In the recorded acceptance run this resolved to BBL `1008350041` / BIN `1015862`, returned 241 locally stored rows across three pages, and reported `CHECKED` coverage.

The five-property fixture is [`seed/acceptance-properties.json`](seed/acceptance-properties.json); it includes the Empire State Building, a Queens hyphenated number, a condo unit, a two-family house, and an unpaid-balance property. With the API running, Node 22 is needed only for the optional evidence runner:

**Cross-platform (Linux / macOS and Windows PowerShell):**

```text
npm run acceptance:small
```

It writes a new timestamped evidence directory, registers the seed, performs two manual runs, and audits duplicates; BIS checks remain manual. The committed run is indexed in [`RUN_LOG.md`](RUN_LOG.md). On 2026-09-17, BIS and local totals matched for Empire State (241 vs 241) and 37-15 82nd Street (10 vs 10), as recorded in [`spot-checks.json`](evidence/acceptance-small/run/bis/spot-checks.json).

Scale headline: a deterministic 10,000-BBL PLUTO sample yielded 9,985 registered properties and 10,800 valid BINs. All 10,000 source BBLs were submitted for registration; the 15 source/resolver-quality failures were retained rather than pre-filtered. The accepted ingestion completed in 1,311.004 s, made 14 Socrata calls including one retry, promoted 81,486 rows, and had zero ingestion failures. The 15 registration failures are retained, not hidden. See [`RUN_LOG.md`](RUN_LOG.md) and [`evidence/scale-10000/summary.json`](evidence/scale-10000/summary.json).
