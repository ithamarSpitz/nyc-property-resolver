---
id: S0-T1
stage: 1
model_class: worker
timeout_minutes: 35
review: true
allow_protected: false
depends_on: []
allowed_paths:
  - package.json
  - package-lock.json
  - tsconfig.json
  - tsconfig.build.json
  - jest.config.cjs
  - .gitignore
  - src/app.ts
  - src/server.ts
  - src/workers/ingestion.worker.ts
  - tests/unit/foundation/toolchain.smoke.test.ts
context:
  - architecture.foundations
  - architecture.testing
  - architecture.implementation_map
verification:
  - npm ci
  - npm run typecheck
  - npm test -- --runInBand tests/unit/foundation/toolchain.smoke.test.ts
---

# Goal

Bootstrap the deterministic Node.js 22 / TypeScript repository and automated-test foundation that every later task can build on.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`.

Pay particular attention to:

- the declared runtime/dependency stack;
- the API/worker split;
- the suggested source structure;
- Jest and Supertest as the automated test stack;
- Docker later needing stable `start:api` and `start:worker` commands.

# Scope

Create the project-level package/toolchain contract:

- `package.json` and committed `package-lock.json`;
- Node 22 engine requirement;
- TypeScript build and typecheck configuration;
- Jest configured for TypeScript;
- all architecture-declared runtime dependencies needed by later sprints, including Express, Zod, Prisma client, `pg`, Bottleneck, Pino, Helmet, and express-rate-limit;
- test/dev dependencies required for Jest, Supertest, TypeScript, Prisma CLI, and Node/Express/PostgreSQL typings;
- stable scripts for build, typecheck, test, `start:api`, and `start:worker`;
- minimal compilable API and worker entrypoints with no domain behavior;
- one fast smoke test proving the Jest/TypeScript harness executes;
- `.gitignore` entries for Node build output, local env files, coverage, and other generated application artifacts while preserving existing harness ignores.

The minimal API may expose a simple health endpoint solely to support foundation/runtime verification. The worker may contain only the minimum long-running process lifecycle needed for Compose smoke testing; it must not implement ingestion scheduling yet.

# Out of scope

Do not implement:

- property resolution;
- NYC clients;
- Prisma domain models or migrations;
- ingestion logic or scheduling;
- application environment parsing;
- production logging behavior;
- Dockerfile or Compose;
- API security/rate-limit middleware beyond what is necessary to compile the foundation.

Do not change architecture/planning documents or harness implementation code.

# Invariants

- Node.js 22 is the supported runtime.
- API and worker remain separate executable processes sharing one codebase.
- The package lock is committed and `npm ci` is the deterministic install path after this task.
- Jest is the behavior-test runner; Supertest is available for later HTTP behavior tests.
- No business behavior is invented in this foundation task.

# Acceptance criteria

1. A clean `npm ci` succeeds from the committed lockfile.
2. `npm run typecheck` succeeds with strict TypeScript settings.
3. `npm run build` produces compilable API/worker output without requiring external NYC services or a running database.
4. `npm test -- --runInBand tests/unit/foundation/toolchain.smoke.test.ts` passes.
5. Stable `start:api` and `start:worker` package scripts exist for the later Docker task.
6. The runtime/test dependencies declared by the architecture are present without introducing an unrelated framework.
7. No domain schema, resolver, ingestion, or API feature implementation is pulled into the task.

# Verification

The YAML `verification` commands are authoritative. The harness reruns them after the agent finishes; an agent self-report is not evidence of completion.
