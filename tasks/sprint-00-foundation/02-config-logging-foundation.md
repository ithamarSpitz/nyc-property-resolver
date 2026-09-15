---
id: S0-T2
stage: 2
model_class: worker
timeout_minutes: 35
review: true
allow_protected: false
depends_on:
  - S0-T1
allowed_paths:
  - .env.example
  - src/config/**
  - src/logging/**
  - src/errors/**
  - src/server.ts
  - src/workers/ingestion.worker.ts
  - tests/unit/foundation/config.test.ts
  - tests/unit/foundation/logger.test.ts
context:
  - architecture.foundations
  - architecture.operations
  - architecture.data_access_validation
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/foundation/config.test.ts tests/unit/foundation/logger.test.ts
---

# Goal

Establish one typed application-configuration boundary and one safe structured-logging/error foundation, then wire the API and worker entrypoints to use them.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`.

Use the environment names/defaults and logging/security constraints from the architecture. Treat `.env.example` as documentation of the public configuration contract, not as a second source of defaults.

# Scope

Implement:

- one Zod-backed environment/config module under `src/config/`;
- parsing/coercion for the architecture-defined operational values;
- `DATABASE_URL` as a required runtime database setting;
- `SOCRATA_APP_TOKEN` as optional;
- architecture-defined defaults such as batch/page/concurrency/retry/body-limit values in one canonical code location;
- representation of `API_RATE_LIMIT` without inventing an architecture default if none is specified;
- `.env.example` containing all public application environment variables and no real secrets;
- a Pino logger foundation with secret/connection-string redaction appropriate to the known config keys;
- a minimal reusable application-error convention for later route/service layers without building the final HTTP error middleware;
- API/worker entrypoint wiring that obtains config and logger through these modules rather than scattered direct `process.env` reads;
- focused unit tests for config validation/defaults and logger redaction/safe behavior.

# Out of scope

Do not implement:

- HTTP security/rate limiting middleware;
- resolver/ingestion domain behavior;
- scheduler behavior;
- Docker/Compose;
- Prisma schema or migrations;
- real external requests.

Do not add a second config/default source in Compose, README, or tests.

# Invariants

- Application code has one validated configuration boundary.
- Secrets are never committed or emitted to logs.
- `.env` remains ignored; `.env.example` contains placeholders only.
- Architecture-owned defaults are not silently changed.
- `SOCRATA_APP_TOKEN` remains optional.
- Full upstream payloads are not part of normal structured logs.

# Acceptance criteria

1. Unit tests prove required/optional environment behavior and numeric coercion/defaults.
2. Architecture-defined defaults have a single canonical owner in application config.
3. Invalid required configuration fails clearly at startup/config parsing rather than much later in a service.
4. Logger tests prove configured secrets/connection strings are redacted or otherwise not emitted in clear text.
5. API and worker entrypoints use the shared config/logger modules and still typecheck.
6. `.env.example` lists the architecture contract without containing credentials.

# Verification

The harness executes the frontmatter verification commands independently.
