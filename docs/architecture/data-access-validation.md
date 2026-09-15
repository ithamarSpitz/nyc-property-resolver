<!-- GENERATED CONTEXT MODULE. Source of truth: /ARCHITECTURE.md. -->
<!-- Do not edit independently; regenerate from the final architecture if it changes. -->

## 13. Prisma

Prisma is the main application data-access layer.

Responsibilities:

- PostgreSQL schema mapping
- typed application queries
- relationships
- migrations
- transactions
- ordinary inserts, updates, and reads

For ingestion paths where a bulk SQL operation is significantly simpler or more efficient, parameterized SQL can be executed through the database layer while keeping Prisma as the primary schema and migration system.

Prisma is not used to own the long-lived PostgreSQL advisory lock because ordinary Prisma access is pooled. The ingestion executor uses one dedicated `pg` connection solely to acquire, hold, and release the session-level lock.

Database schema changes are committed as migrations so the same database structure is created when the project is run on another machine.

---
## 14. Zod Validation

Zod is used at two different validation levels.

### API input

Examples:

- property creation payload
- BBL format
- pagination parameters
- boolean filters
- bulk import payloads

### External NYC data

External responses first receive minimal transport-level validation so they can be safely parsed and persisted as raw JSON.

```text
HTTP response
    |
    v
JSON parsing / minimal structural validation
    |
    v
Raw persistence
    |
    v
Strict domain validation
    |
    v
Normalization
```

Strict Zod schemas are applied after raw persistence to validate the fields required by the normalized ECB model.

If strict validation or normalization fails, the raw payload remains available, the error is recorded, and the affected batch is marked partial or failed. This preserves the ability to fix parsing logic and re-derive normalized data without fetching the source again.

---
## 15. External HTTP Clients

Node.js native `fetch` is used for outbound HTTP.

External systems are wrapped in dedicated clients, for example:

```text
GeoSearchClient
PlutoClient
CondoUnitsClient
CondominiumsClient
BuildingFootprintsClient
SocrataClient
```

These clients are responsible for:

- URL construction
- query parameters
- authentication tokens when configured
- stable ordering for paginated Socrata queries
- page size and pagination parameters
- Socrata dataset metadata / `rowsUpdatedAt` retrieval
- timeout handling
- HTTP status validation
- parsing
- logging
- retryable error classification

Business services do not construct Socrata or GeoSearch HTTP calls directly.

---


### ECB Socrata Query Contract

Every DOB ECB page query explicitly requests the Socrata system fields required by the ingestion schema:

```text
$select=:id,:updated_at,*
```

Queries may use these fields for stable ordering as well:

```text
$order=:updated_at,:id
```

This is a required client invariant. The ingestion schema depends on:

```text
socrata_row_id = :id
source_row_updated_at = :updated_at
```

and these fields must not be assumed to appear implicitly in SODA 2.1 responses.
## 16. Bottleneck

Bottleneck controls external API concurrency and pacing.

Example configuration:

```text
maxConcurrent = SOCRATA_CONCURRENCY
```

Optionally:

```text
minTime = configured delay between requests
```

It sits immediately around external Socrata operations:

```text
Ingestion batches
       |
       v
Bottleneck
       |
       v
SocrataClient
```

This ensures a configuration or code change cannot accidentally create unbounded parallel requests.

---
