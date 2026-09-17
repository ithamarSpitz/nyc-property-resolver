---
id: S4-T9
stage: 5
model_class: worker
timeout_minutes: 40
review: true
allow_protected: false
depends_on:
  - S4-T8
allowed_paths:
  - package.json
  - scripts/verify-api-operations.mjs
context:
  - architecture.foundations
  - architecture.operations
  - architecture.testing
  - architecture.implementation_map
environment: docker
verification:
  - npm run typecheck
  - docker compose config --quiet
  - npm run verify:api-operations
---

# Goal

Remove the task-worktree-only API host-port workaround introduced by S4-T8 and make the API/operations verification command itself deterministic under isolated Docker execution.

The defect proven after S4-T8 integration is specific: task verification passed because `npm ci` ran a `postinstall` hook that wrote `.env` with `API_HOST_PORT=0`, but the Stage 4 integration checkout did not receive that task-worktree side effect. The stage barrier therefore tried to publish host port 3000 and failed when that port was already occupied.

# Required context

Read only the listed architecture aliases plus `AGENTS.md`, the existing `scripts/verify-foundation.mjs` port-isolation pattern, the S0 API port contract, and the completed S4-T8 verification contract.

# Scope

Implement exactly this corrective verification contract:

- Remove the S4-T8 `postinstall` script from `package.json` completely.
- Remove the `postinstall` hook so future `npm install` / `npm ci` never writes or replaces `.env`.
- The Harness may already have created a stale `.env` in the S4-T9 worktree before this task begins because setup runs against the pre-fix `package.json`. If, and only if, that file contains exactly `API_HOST_PORT=0` (ignoring the final newline), remove that generated file before verification. Do not delete or rewrite any other `.env` content.
- Replace the long inline `verify:api-operations` npm command with:
  `node scripts/verify-api-operations.mjs`.
- Add `scripts/verify-api-operations.mjs` as the single owner of the S4 gate's Docker verification lifecycle.
- For every Docker Compose subprocess owned by this verifier, preserve the caller environment and explicitly override only `API_HOST_PORT=0`.
- If `COMPOSE_PROJECT_NAME` is already supplied by the Harness, preserve it unchanged. If it is absent, create one randomized verifier-only Compose project name and use that same name for the entire verification run; never fall back to the repository's normal default Compose project.
- The verifier must not require host port 3000 to be free.
- Build/start the production-shaped Compose services, then run the same two S4 gate suites inside the `worker` service:
  - `tests/integration/api/api-operations-gate.test.ts`
  - `tests/integration/operations/scheduler-cli-gate.test.ts`
- Preserve the existing gate environment passed into the worker:
  - `API_OPERATIONS_GATE=1`
  - `API_OPERATIONS_GATE_API_URL=http://api:3000`
  - `API_OPERATIONS_GATE_COMPOSE_YAML_B64=<base64 of docker-compose.yml>`
- Propagate subprocess failures with a non-zero exit status and useful output.
- Before startup, run a best-effort `docker compose down -v --remove-orphans` for exactly the verifier-owned Compose project, then always attempt the same cleanup again in `finally`, including on verification failure.
- Never clean, stop, or mutate a different/default Compose project merely because it uses the same repository.
- Keep the normal application/evaluator Docker contract unchanged: outside this verification command, absence of `API_HOST_PORT` still means the existing default host mapping to port 3000.

# Out of scope

Do not:

- change `docker-compose.yml`, application runtime configuration, API routes, query semantics, ingestion logic, or tests merely to make the gate pass;
- add a global `API_HOST_PORT=0` default;
- write `.env` or any other repository file at install/verification time;
- contact real NYC sources;
- weaken the existing S4 assertions;
- change the container API port from 3000.

# Invariants

- Host-port ephemerality is verification-only.
- Container-to-container API traffic remains `http://api:3000`.
- Normal `docker compose up` behavior remains the evaluator-facing default already established by the S0 port contract.
- The verifier must work with the Harness's isolated `COMPOSE_PROJECT_NAME`; outside Harness it must use a randomized verifier-only project name, never a fixed project name and never the evaluator/default Compose project.
- No package-install side effect is used to prepare verification state.

# Acceptance criteria

1. `package.json` no longer contains the S4 `postinstall` `.env` writer.
2. `npm run verify:api-operations` delegates to `scripts/verify-api-operations.mjs`.
3. With caller `API_HOST_PORT` absent, the verifier explicitly gives its Compose subprocesses `API_HOST_PORT=0` and does not depend on host port 3000 being free; direct invocation also uses a randomized verifier-only Compose project.
4. The two existing S4 integration suites pass unchanged through the production-shaped Compose runtime.
5. Compose resources are cleaned up on both success and failure paths.
6. No `.env` file is created or overwritten by npm installation or by the S4 verifier.
7. The normal non-verification Compose default remains unchanged.

# Verification

The frontmatter commands are authoritative. Stage 5 repeats `npm run verify:api-operations` after merge so the corrected verifier is proven from the integration checkout, not only from the task worktree.
