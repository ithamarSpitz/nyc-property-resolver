---
id: S2-T5
stage: 2
model_class: hard_worker
timeout_minutes: 50
review: true
allow_protected: false
depends_on:
  - S2-T1
allowed_paths:
  - src/services/ecb/ingestion-lock.service.ts
  - tests/unit/ingestion/ingestion-lock-authority.test.ts
  - tests/integration/ingestion/advisory-lock.integration.test.ts
context:
  - architecture.ingestion_lifecycle
  - architecture.data_access_validation
environment: docker
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/ingestion/ingestion-lock-authority.test.ts
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/ingestion/advisory-lock.integration.test.ts
---

# Goal

Implement the dedicated-session PostgreSQL advisory-lock ownership primitive and execution-authority object that makes losing the lock-owning session an immediate fail-stop condition for ECB ingestion.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md` and the existing database/config foundations.

# Scope

Implement an ECB ingestion lock/authority service using a dedicated `pg.Client` connection, not a pooled Prisma query. It must:

- derive/use a deterministic dataset lock key for `DOB_ECB_VIOLATIONS`;
- acquire with `pg_try_advisory_lock`;
- keep the exact owning PostgreSQL session open for the executor lifetime;
- return an explicit active-executor result when acquisition fails rather than waiting/unbounded blocking;
- expose execution-authority state plus an `AbortSignal` used by the ingestion executor/source-request layer;
- register `error` and `end` handlers on the owning client;
- atomically revoke authority and abort the signal if either handler fires unexpectedly while active;
- provide guard/check behavior so state-changing run/batch/promotion callers can refuse work after authority loss;
- release/unlock/close cleanly on normal completion while tolerating a connection that has already died.

Use a real PostgreSQL integration test to prove competing lock ownership and release semantics. Unit-level tests may use a fake `pg.Client` event emitter to force session-loss paths deterministically.

# Out of scope

Do not implement:

- ingestion run initialization;
- batch processing;
- Socrata requests;
- promotion/coverage;
- fencing tokens/executor epochs beyond the architecture's take-home scope;
- scheduler/manual CLI wiring.

# Invariants

- The lock is owned by one dedicated PostgreSQL session for the entire ingestion execution.
- Prisma pool health does not preserve execution authority after the lock session is lost.
- Unexpected lock-client `error`/`end` immediately sets authority false and aborts downstream work.
- A process that does not own the advisory lock may not create/resume/execute ingestion work.

# Acceptance criteria

1. One integration client can acquire the ECB advisory lock while a competing client receives a non-owning/active-executor result.
2. Releasing/closing the owning client permits a later client to acquire the same lock.
3. Forced `error` and forced unexpected `end` revoke execution authority and trigger the abort signal exactly once.
4. Authority guards reject state-changing operations after session loss even if unrelated Prisma connectivity remains conceptually available.
5. Normal cleanup does not misclassify an intentional release as an unexpected authority loss.

# Verification

The real-PostgreSQL test proves session ownership; deterministic unit tests prove fail-stop authority semantics.
