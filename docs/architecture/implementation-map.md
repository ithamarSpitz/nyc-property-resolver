<!-- GENERATED CONTEXT MODULE. Source of truth: /ARCHITECTURE.md. -->
<!-- Do not edit independently; regenerate from the final architecture if it changes. -->

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
