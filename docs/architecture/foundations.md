<!-- GENERATED CONTEXT MODULE. Source of truth: /ARCHITECTURE.md. -->
<!-- Do not edit independently; regenerate from the final architecture if it changes. -->

## 1. Overview

This service resolves NYC properties into stable NYC identifiers, periodically ingests DOB ECB Violations for the tracked property watchlist, stores both raw and normalized data locally, and exposes the stored data through an HTTP API.

The system is designed around five core principles:

1. **Resolve once, scan by identifiers**  
   Property addresses are resolved once and persisted with their BBL and BIN identifiers. Recurring scans use the stored identifiers and do not geocode properties again.

2. **Serve monitored-data queries from the local database**  
   Property registration is a one-time resolution operation and may call NYC resolution sources. Once a property is resolved, stored-property and ECB query endpoints are served entirely from the local database and never depend on NYC APIs at request time.

3. **Use watchlist-based ingestion**  
   ECB data is fetched only for BINs belonging to tracked properties. BINs are deduplicated and fetched in batches.

4. **Promote only successful normalized state**  
   Raw payloads are persisted immediately, but normalized candidates are written to run-scoped staging. The live normalized table is updated only after the run is accepted.

5. **Persist operational state**  
   Ingestion progress, failures, freshness, and coverage are stored in PostgreSQL so runs can be resumed safely and API consumers can distinguish between successful empty results, unprocessed properties, and failed fetches.

---
## 2. Technology Stack

| Layer | Technology | Responsibility |
|---|---|---|
| Runtime | Node.js 22 | Runs the API and ingestion worker |
| Language | TypeScript | Application code and type safety |
| HTTP API | Express | REST API and HTTP middleware |
| Validation | Zod | Runtime validation of API input and external data |
| Database | PostgreSQL | Persistent source of truth |
| Database access | Prisma | Data access, schema models, migrations |
| Lock ownership | `pg` (node-postgres) | Dedicated PostgreSQL session for advisory-lock ownership |
| External HTTP | Native `fetch` | GeoSearch, PLUTO, Building Footprints, Socrata |
| Concurrency control | Bottleneck | Limits concurrent and paced external requests |
| Logging | Pino | Structured application and ingestion logs |
| Unit / behavior tests | Jest | Business logic and ingestion tests |
| API tests | Supertest | HTTP endpoint tests |
| Security headers | Helmet | Standard HTTP security headers |
| API rate limiting | express-rate-limit | Basic protection against excessive requests |
| Containers | Docker | Reproducible application runtime |
| Local orchestration | Docker Compose | Starts PostgreSQL, API, and worker together |

---
## 3. High-Level Architecture

```text
                         Client
                           |
                           v
                  +----------------+
                  |  Express API   |
                  |----------------|
                  | Zod            |
                  | Helmet         |
                  | Rate Limiting  |
                  +--------+-------+
                           |
                         Prisma
                           |
                           v
                  +----------------+
                  |   PostgreSQL   |
                  +----------------+
                           ^
                           |
                           |
                  +--------+-------+
                  | Ingestion      |
                  | Worker         |
                  |----------------|
                  | Scheduler      |
                  | Watchlist Sync |
                  +--------+-------+
                           |
                      Bottleneck
                           |
                      Native fetch
                           |
                           v
                  +----------------+
                  | NYC Open Data  |
                  | / Socrata      |
                  +----------------+
```

The API and ingestion worker run as separate processes but share the same codebase and PostgreSQL database.

---
## 4. Application Components

### 4.1 Express API

The Express application exposes the public HTTP interface.

Primary responsibilities:

- Accept property creation and lookup requests.
- Accept bulk BBL registration requests and route them through the batch-resolution path.
- Validate incoming payloads and query parameters.
- Invoke application services.
- Read property and ECB data from PostgreSQL.
- Return pagination, freshness, and coverage metadata.
- Apply basic HTTP security middleware.

The HTTP layer should remain thin. Business logic belongs in services rather than directly inside route handlers.

Example flow:

```text
HTTP Request
    |
    v
Express Route
    |
    v
Zod Validation
    |
    v
Application Service
    |
    v
Prisma / PostgreSQL
```

---
