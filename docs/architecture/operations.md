<!-- GENERATED CONTEXT MODULE. Source of truth: /ARCHITECTURE.md. -->
<!-- Do not edit independently; regenerate from the final architecture if it changes. -->

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
