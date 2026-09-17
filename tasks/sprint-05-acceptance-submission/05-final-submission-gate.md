---
id: S5-T5
stage: 7
model_class: hard_worker
timeout_minutes: 120
review: true
allow_protected: false
depends_on:
  - S5-T4
allowed_paths:
  - package.json
  - scripts/final-submission-gate.mjs
  - tests/submission/**
context:
  - assignment
  - architecture.operations
  - architecture.testing
  - architecture.implementation_map
environment: docker
verification:
  - npm run verify:submission
---

# Goal

Create and pass the final adversarial submission gate that simulates what the evaluator receives: a clean repository tree, Docker available, documented commands, real reference-property flow, and no hidden local state.

# Required context

Read only the listed contexts plus `AGENTS.md`, final README/DESIGN/RUN_LOG, seeds, and S5 evidence.

# Scope

Create `npm run verify:submission` backed by a cross-platform Node script/test suite that validates the prospective committed repository from a temporary clean directory, not the developer's existing database/containers/node_modules.

The gate must:

1. construct a temporary clean copy from the files that would be committed by the Harness, excluding `.git`, `.harness`, local `.env`, caches, existing node_modules and Docker volumes;
2. verify all assignment deliverables exist: code, Compose, README, DESIGN, 5–8 property seed, 10k BBL seed, baseline/idempotent logs, scale summary and behavior tests;
3. scan tracked deliverables for accidentally committed secrets and fail on `.env`/token leakage while allowing `.env.example`;
4. validate README's documented startup/manual-ingestion commands against the actual package/Compose entrypoints so stale documentation fails;
5. start the copied repository through the documented one-command Docker path and verify postgres→migrate→api/worker readiness from clean storage;
6. run the automated behavior suite/typecheck in the clean runtime;
7. execute the shared reference flow using **350 5th Avenue, Manhattan**: resolve through the public API, trigger ingestion through the documented manual worker CLI, then query violations from the application's local API and capture coverage/freshness;
8. prove the query step still succeeds from local accepted state without issuing a request-time Socrata fetch (use existing S4 instrumentation/test seam where needed; do not redesign production code here);
9. mechanically validate S5 small/scale evidence and documentation references;
10. tear down the temporary Compose project and volumes on success or failure.

Use a dedicated Compose project name/temp directory so the final gate cannot pass by accidentally talking to an earlier S5 database. Preserve a concise final-gate log when failing for diagnosis, but do not add a second set of benchmark claims.

If the clean-copy gate reveals a defect, do not patch unrelated application behavior inside this task. Identify the owning S0–S4/S5 task and use focused recovery or plan repair. This task owns only the final verifier/tests/package script.

# Out of scope

Do not:

- rerun the full 10,000-property benchmark;
- alter README/DESIGN/evidence to make assertions easier;
- introduce deployment/auth/UI/stretch features;
- weaken tests because live reference behavior is inconvenient;
- depend on globally installed PostgreSQL, Prisma, TypeScript or app node_modules outside Docker;
- require a committed Socrata token.

# Invariants

- Clean verification starts from empty application DB state and an isolated Compose namespace.
- The evaluator path needs Docker, not hidden host services.
- The Empire State reference request is resolved live once; ECB query is then served from local accepted state.
- Temporary resources are removed even on failure.
- Existing S0–S4 behavior gates remain part of final verification rather than being replaced by a superficial smoke test.

# Acceptance criteria

1. `npm run verify:submission` passes from the integrated repository and uses a clean temporary repository/runtime state.
2. All required hand-in artifacts and evidence are present and internally consistent.
3. The documented one-command startup works with deterministic migration ordering.
4. The real Empire State resolve → manual ingest → local ECB query flow succeeds and exposes coverage/freshness.
5. Full automated behavior/typecheck verification still passes in the clean runtime.
6. Secret scanning finds no committed runtime secret.
7. The final gate leaves no temporary containers/volumes/directories after completion.
8. A failure produces actionable attribution rather than silently modifying previous task-owned behavior.

# Verification

This is the final project gate. Passing it means the repository is ready for hand-in; no later sprint exists to repair missing deliverables silently.
