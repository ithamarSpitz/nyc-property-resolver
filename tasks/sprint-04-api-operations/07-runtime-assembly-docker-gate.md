---
id: S4-T7
stage: 3
model_class: hard_worker
timeout_minutes: 65
review: true
allow_protected: false
depends_on:
  - S4-T3
  - S4-T5
  - S4-T6
allowed_paths:
  - src/app.ts
  - src/server.ts
  - Dockerfile
  - docker-compose.yml
  - tests/integration/operations/runtime-assembly.test.ts
context:
  - architecture.api
  - architecture.operations
  - architecture.implementation_map
  - architecture.testing
environment: docker
verification:
  - npm run typecheck
  - docker compose config --quiet
  - docker compose build
  - docker compose up -d
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/operations/runtime-assembly.test.ts
---

# Goal

Assemble the final production-shaped API/worker runtime: wire HTTP middleware/routes, preserve deterministic migration ordering, and prove the scheduled/manual ingestion entrypoints are available from the worker container.

# Required context

Read only the context aliases in frontmatter plus `AGENTS.md`, the S0 Docker foundation, S4-T3 scheduler/CLI, S4-T4 middleware, and S4-T5/T6 route modules.

# Scope

Finalize application/runtime composition so that:

- `app.ts` installs explicit JSON body limiting, Helmet, rate limiting, routes, and terminal error handling in a deterministic safe order;
- the S1 property routes plus S4 property/portfolio violation routes are mounted exactly once;
- `server.ts` starts the API from the validated config/logger boundary;
- the worker container runs the S4-T3 scheduler entrypoint and the same image supports the one-shot manual CLI;
- Docker Compose preserves:

```text
postgres healthy
    -> migrate (prisma migrate deploy) completed successfully
        -> api + worker
```

- API and worker do not independently race migrations;
- `docker compose up --build` remains the clean-machine one-command runtime;
- the worker image contains everything required for `docker compose run --rm worker npm run ingest:ecb`;
- the runtime integration test can start without access to external NYC APIs until an explicit resolver/ingestion action is invoked.

# Out of scope

Do not:

- run the real acceptance seed;
- run the 10,000-property scale test;
- change ingestion semantics;
- add authentication/deployment infrastructure.

# Invariants

- PostgreSQL is the only served ECB source during query requests.
- Migration ordering is deterministic and single-owner.
- API and worker are separate processes sharing one application image/codebase.
- Manual and scheduled ingestion share the same ingestion implementation.

# Acceptance criteria

1. `docker compose config --quiet` succeeds.
2. A clean Compose start reaches healthy PostgreSQL, successful `migrate`, running API and running worker in the required dependency order.
3. API health endpoint responds after the clean start.
4. Property and portfolio ECB endpoints are mounted once and query seeded local data successfully without external network calls.
5. Worker startup owns scheduler lifecycle; no second polling loop exists elsewhere.
6. The worker container exposes `npm run ingest:ecb`; automated smoke may exercise its wiring with a test seam rather than performing a live Socrata run.
7. Stopping/restarting API does not rerun migrations from API startup itself.

# Verification

Use Docker Compose as the runtime under test. Avoid live NYC traffic; S5 owns real-data acceptance.
