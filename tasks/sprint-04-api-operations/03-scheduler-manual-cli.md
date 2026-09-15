---
id: S4-T3
stage: 1
model_class: worker
timeout_minutes: 50
review: true
allow_protected: false
depends_on: []
allowed_paths:
  - src/workers/scheduler.ts
  - src/workers/ingestion.worker.ts
  - src/cli/ingest-ecb.ts
  - package.json
  - tests/unit/operations/scheduler.test.ts
  - tests/unit/operations/ingest-ecb-cli.test.ts
context:
  - architecture.operations
  - architecture.ingestion_lifecycle
  - architecture.implementation_map
  - architecture.testing
environment: null
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/operations/scheduler.test.ts tests/unit/operations/ingest-ecb-cli.test.ts
---

# Goal

Implement scheduled and manual ECB execution entrypoints that both delegate to the single ingestion service/executor built in S2/S3, with no second ingestion implementation.

# Required context

Read only the context aliases listed in frontmatter plus `AGENTS.md`, the existing validated config boundary, and the final S2/S3 ingestion executor/publication composition.

# Scope

Implement:

- `src/workers/scheduler.ts` using the configured ingestion interval from the validated application config;
- worker entrypoint wiring that starts the scheduler without duplicating ingestion logic;
- `src/cli/ingest-ecb.ts` as the manual one-run entrypoint;
- an `npm run ingest:ecb` package script used by:

```bash
docker compose run --rm worker npm run ingest:ecb
```

- both paths calling the same ingestion service/executor factory/composition root;
- propagation/reporting of the existing “another executor owns the advisory lock” outcome rather than trying to start competing work;
- graceful scheduler lifecycle suitable for a long-running worker process;
- structured start/completion/failure summary logging using the shared logger, without logging secrets or full source payloads.

# Out of scope

Do not implement:

- a second ingestion algorithm inside the CLI;
- admin HTTP trigger endpoint;
- query API routes;
- acceptance real-data execution;
- deployment-specific process managers.

# Invariants

- Schedule interval is configuration, not hard-coded business logic.
- Scheduled and manual execution invoke the same ingestion implementation.
- Advisory-lock ownership behavior remains authoritative; entrypoints do not bypass it.
- Manual invocation exits with an explicit success/failure result suitable for walkthrough use.

# Acceptance criteria

1. Scheduler tests with fake timers/config prove the configured interval controls invocation cadence without waiting real time.
2. Worker startup creates one scheduler path rather than embedding a second ingestion loop.
3. CLI test proves exactly one ingestion execution is invoked and the process outcome reflects success/failure/active-owner outcomes.
4. Scheduler and CLI tests assert they call the same injectable ingestion service boundary.
5. `npm run ingest:ecb` exists and points to the CLI implementation.
6. Logged summaries contain operational counts/status but no configured token/connection-string value or complete raw payload.

# Verification

Use dependency injection/fakes around the ingestion service and timers. Do not make real NYC requests in these tests.
