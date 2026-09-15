---
id: S0-T5
stage: 3
model_class: hard_worker
timeout_minutes: 45
review: true
allow_protected: false
depends_on:
  - S0-T2
  - S0-T3
  - S0-T4
allowed_paths:
  - package.json
  - harness.yaml
  - scripts/verify-foundation.mjs
  - tests/integration/foundation/prisma-smoke.test.ts
context:
  - architecture.foundations
  - architecture.operations
  - architecture.testing
verification:
  - npm run verify:foundation
---

# Goal

Turn the individually verified S0 foundations into one reproducible integrated foundation gate, and enable the harness defaults that become safe only after `package-lock.json` and Compose exist.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`.

This task runs after S0-T2/S0-T3/S0-T4 have been integrated, so it is the first S0 task allowed to verify the real Node + Prisma + PostgreSQL + Docker chain together.

# Scope

Implement a cross-platform Node verification script (`scripts/verify-foundation.mjs`) and expose it as `npm run verify:foundation`.

The script must fail fast while still cleaning Docker resources in a `finally`/equivalent cleanup path. It must verify, in an appropriate deterministic sequence:

- TypeScript typecheck;
- automated Jest tests;
- Prisma schema validation/generation as needed;
- `docker compose config`;
- application image build;
- PostgreSQL startup/health;
- `prisma migrate deploy` through the Compose migrate service;
- a real Prisma -> PostgreSQL connectivity smoke test using `tests/integration/foundation/prisma-smoke.test.ts` from inside the Compose network/application image or another isolation-safe approach;
- API and worker container startup;
- the minimal API health endpoint responds successfully;
- cleanup tears down the verification environment/volumes even after a failure.

After that gate works, update `harness.yaml` for post-S0 execution:

- worktree setup uses `npm ci`;
- Docker task isolation is enabled;
- keep the existing per-task Compose namespace/cleanup policy;
- do not hard-code model names or change quota/plan-repair behavior.

Do not weaken existing harness safety settings merely to make verification pass.

# Out of scope

Do not implement:

- S1 property schema/logic;
- NYC clients;
- ingestion behavior;
- scheduler/manual ingestion command;
- final acceptance or 10k scale tests;
- README/DESIGN submission content.

Do not rewrite Docker/Prisma/config foundations unless integration evidence shows a real defect. If a correction requires paths owned by a prior task, stop with a precise integration failure/plan-gap rather than silently broadening this task's scope.

# Invariants

- Foundation verification tests the same Docker/migration topology the reviewer will later use.
- A failed integration check leaves no misleading successful state and cleans temporary Docker resources.
- PostgreSQL correctness is smoke-tested against a real PostgreSQL container, not a mock.
- The Harness becomes Docker-aware only after the Compose foundation exists.
- Future worktrees use deterministic `npm ci` after this task is integrated.

# Acceptance criteria

1. `npm run verify:foundation` passes from a clean S0-integrated checkout with Docker available.
2. The verification script proves build/typecheck/Jest/Prisma/Compose startup rather than only checking configuration syntax.
3. A real Prisma query reaches the Compose PostgreSQL instance successfully.
4. API and worker services start only after the migrate service completes successfully.
5. The API health smoke succeeds.
6. Verification always attempts Docker cleanup on success and failure.
7. `harness.yaml` switches future worktree setup to `npm ci` and enables the already-built isolated Docker environment manager without altering unrelated Harness policies.

# Verification

This task is the S0 integration gate. The harness runs `npm run verify:foundation` again after merging the task into the integration checkout as the Stage 3 barrier.
