---
id: S4-T8
stage: 4
model_class: hard_worker
timeout_minutes: 70
review: true
allow_protected: false
depends_on:
  - S4-T7
allowed_paths:
  - package.json
  - tests/integration/api/api-operations-gate.test.ts
  - tests/integration/operations/scheduler-cli-gate.test.ts
context:
  - architecture.api
  - architecture.operations
  - architecture.testing
  - architecture.implementation_map
environment: docker
verification:
  - npm run typecheck
  - docker compose config --quiet
  - docker compose build
  - node -e "process.env.API_HOST_PORT='0'; require('node:child_process').execSync('npm run verify:api-operations',{stdio:'inherit',env:process.env})"
---

# Goal

Create the full S4 behavior gate proving the query API and operational entrypoints work together from the local store in the production-shaped Docker runtime.

# Required context

Read only the listed architecture aliases plus `AGENTS.md` and all completed S4 implementation contracts.

# Scope

Add a focused `npm run verify:api-operations` verification suite that exercises the integrated S4 behavior without real NYC dependencies.

The gate must verify together:

- property ECB GET serves only accepted local live data plus explicit coverage/freshness;
- checked-empty, not-checked and failed-fetch coverage are distinguishable at the HTTP boundary;
- `openOnly` and `unpaidOnly` exact semantics;
- property ordering `issue_date DESC NULLS LAST, source_id DESC`;
- property cursor traversal across the dated→NULL boundary and multiple NULL-tail pages without duplicate/omitted IDs;
- portfolio endpoint current-membership filtering and shared-BIN de-duplication;
- `updatedSince` uses `source_row_updated_at > timestamp` and matching stable cursor order;
- invalid query/cursor input receives safe client errors;
- no ECB query request calls Socrata or property-resolution NYC clients;
- scheduled worker and manual CLI use the same ingestion service boundary;
- Docker startup ordering remains postgres→migrate→api/worker and the complete service starts from Compose.

# Out of scope

Do not:

- contact real NYC sources;
- perform BIS spot checks;
- run the real seed set or 10k benchmark;
- write README/DESIGN submission evidence;
- implement new features to make the test easier.

# Invariants

- This Task is a verification/integration gate, not a place to redesign query or ingestion behavior.
- A failing behavior should identify the owning earlier Task/contract rather than silently weakening assertions.
- Real external acceptance remains S5.

# Acceptance criteria

1. `npm run verify:api-operations` is deterministic and passes against isolated PostgreSQL/Docker state.
2. The test suite proves complete ordered pagination, not only first-page results.
3. Local-store-only behavior is enforced with fail-fast upstream client seams.
4. Scheduler/manual paths demonstrably resolve to the same ingestion executor/service composition.
5. Compose can start the complete service and API requests work after migration completion.
6. No real NYC network access is required for the S4 gate.

# Verification

The frontmatter commands are authoritative. The temporary `API_HOST_PORT=0` child-process injection in this task's verification exists only so this already-integrated task can be revalidated before S4-T9 removes the old install-time `.env` workaround. It changes only Docker host publishing; the container API remains on port 3000 and the normal evaluator path remains unchanged.

Keep this suite focused enough for repeated automated execution; S5 owns slow real-data/scale evidence.
