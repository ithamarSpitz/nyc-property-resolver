# NYC Property Resolver and DOB ECB Pipeline

Resolves NYC addresses or 10-digit BBLs once, stores canonical parcel/building identifiers in PostgreSQL, refreshes DOB ECB violations on a schedule, and serves ECB queries from the local database. Property registration may call NYC resolution sources; stored-property and ECB query requests never call Socrata.

## Run

Requires Docker with Compose only:

```text
docker compose up --build
```

Compose applies migrations, starts the API at `http://localhost:3000`, and starts the ingestion worker. The worker runs immediately and then weekly by default.

To change the interval, copy `.env.example` to an untracked `.env` and override:

```env
INGEST_INTERVAL_MS=86400000
# Optional; never commit the token or .env
SOCRATA_APP_TOKEN=your-token-here
```

Trigger one ingestion run manually:

```text
docker compose run --rm worker npm run ingest:ecb
```

Resolver sources are split by responsibility: GeoSearch resolves free-text address candidates, PLUTO anchors parcel identity, the Condominium Units/Condominiums datasets bridge condo unit lots to the building parcel, and Building Footprints validates building-level BINs. ECB scans then use the stored BINs in bounded batches.

## API examples

Base URL: `http://localhost:3000`. All responses are JSON.

### Create / resolve property

```http
POST /properties
Content-Type: application/json

{"address":"350 5th Avenue, Manhattan, NY"}
```

```json
{"id":"21f0f802-96f9-4ce3-b6dd-8e5b54dc2556","identifierVersion":1,"bbl":"1008350041","condoBaseBbl":null,"condoBillingBbl":null,"normalizedAddress":"350 5th Avenue, Manhattan, Ny","borough":1,"block":835,"lot":41,"bins":["1015862"],"createdAt":"2026-09-17T12:40:19.561Z","resolvedAt":"2026-09-17T12:40:19.558Z"}
```

`{"bbl":"1008350041"}` is also accepted; repeated input is idempotent.

### Get property

```http
GET /properties/21f0f802-96f9-4ce3-b6dd-8e5b54dc2556
```

```json
{"id":"21f0f802-96f9-4ce3-b6dd-8e5b54dc2556","identifierVersion":1,"bbl":"1008350041","condoBaseBbl":null,"condoBillingBbl":null,"normalizedAddress":"350 5th Avenue, Manhattan, Ny","borough":1,"block":835,"lot":41,"bins":["1015862"],"createdAt":"2026-09-17T12:40:19.561Z","resolvedAt":"2026-09-17T12:40:19.558Z"}
```

### Get property ECB violations

```http
GET /properties/21f0f802-96f9-4ce3-b6dd-8e5b54dc2556/ecb-violations?openOnly=false&unpaidOnly=false&limit=1
```

```json
{"violations":[{"sourceId":"1572407","bin":"1015862","violationNumber":"39107427M","issueDate":"2024-03-01","ecbViolationStatus":"RESOLVE","balanceDue":"0","sourceRowUpdatedAt":"2025-10-20T17:02:25.556Z"}],"coverage":{"status":"CHECKED","statusReason":null,"lastAttemptAt":"2026-09-17T12:40:36.464Z","lastSuccessAt":"2026-09-17T12:40:36.464Z","sourceWatermarkAt":"2026-09-16T16:59:26.000Z","lastError":null},"page":{"limit":1,"hasMore":true,"nextCursor":"<cursor>"}}
```

Newest first. Optional: `openOnly`, `unpaidOnly`, `limit=1..100`, `cursor`. Coverage distinguishes checked-and-empty, not-yet-checked, and failed fetches.

### Register properties in bulk

```http
POST /properties/bulk
Content-Type: application/json

{"bbls":["1008350041"]}
```

```json
{"summary":{"submitted":1,"unique":1,"succeeded":1,"failed":0,"cached":0},"results":[{"inputBbl":"1008350041","canonicalBbl":"1008350041","status":"succeeded","property":{"id":"21f0f802-96f9-4ce3-b6dd-8e5b54dc2556","bbl":"1008350041","borough":1,"block":835,"lot":41,"normalizedAddress":"350 5th Avenue, Manhattan, Ny","condoBaseBbl":null,"condoBillingBbl":null,"identifierVersion":1,"bins":["1015862"],"coverage":[{"dataset":"DOB_ECB_VIOLATIONS","status":"NOT_CHECKED","statusReason":"NEVER_INGESTED"}]}}]}
```

Accepts 1–10,000 BBLs per request and reports failures per input.

### List ECB results across properties

```http
GET /ecb-violations?unpaidOnly=true&limit=1
```

```json
{"violations":[{"id":"af7ca7d3-bb39-4d73-aa3f-8735bfe9b936","sourceId":"1671991","socrataRowId":"row-atgj~8tec~94sg","bin":"4015377","violationNumber":"39195205J","issueDate":"2026-07-08","ecbViolationStatus":"ACTIVE","balanceDue":"6250.00","sourceRowUpdatedAt":"2026-09-16T16:59:22.394Z","lastSuccessRunId":"796d778e-f98f-4ceb-813d-801e3091f10c","isCurrent":true}],"page":{"limit":1,"hasMore":true,"nextCursor":"<cursor>"}}
```

Optional: `unpaidOnly`, `updatedSince`, `limit=1..100`, `cursor`. This endpoint returns current accepted violations only; per-property freshness and coverage are exposed above.

## Verification

BIS spot checks matched the local store for Empire State Building (241 vs 241 ECB violations) and 37-15 82nd Street (10 vs 10).

See [`WALKTHROUGH.md`](WALKTHROUGH.md) for platform-specific copy-paste commands and the fuller operational walkthrough. See [`seed/acceptance-properties.json`](seed/acceptance-properties.json), [`RUN_LOG.md`](RUN_LOG.md), [`DESIGN.md`](DESIGN.md), and [`evidence/`](evidence/) for the required seed, baseline/idempotent runs, 10,000-property scale run, BIS records, and design details.
