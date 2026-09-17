---
id: S4-T10
stage: 6
model_class: worker
timeout_minutes: 45
review: true
allow_protected: false
depends_on:
  - S4-T9
allowed_paths:
  - docker-compose.yml
  - scripts/verify-runtime-config.mjs
context:
  - architecture.foundations
  - architecture.operations
  - architecture.testing
  - architecture.implementation_map
environment: docker
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/foundation/config.test.ts
  - docker compose config --quiet
  - node scripts/verify-runtime-config.mjs
  - npm run verify:api-operations
---

# Goal

Close the runtime-configuration propagation gap before S5: operational environment values documented by the application configuration contract must actually reach the production-shaped Docker services that consume them.

This is a wiring correction, not a new feature. Application defaults remain owned by `src/config/**`; Compose must not become a second source of ingestion defaults.

# Human-approved plan-change basis

CR-0004's planner returned `UNKNOWN` because S4-T7 itself is green and its persisted failure summary is only `Task exhausted its normal path`. The corrective task is therefore not justified by a failed S4-T7 command.

The human gate is instead acting on a directly observed contract gap:

- `.env.example` and `src/config/env.ts` expose runtime controls including `INGEST_INTERVAL_MS`, Socrata paging/concurrency/retry controls and API limits;
- the architecture states that operational values are supplied through environment variables and that the worker reads its schedule interval from configuration;
- the current Compose runtime does not forward most of those values into the worker, so changing the host environment does not change the container runtime.

No architecture change is required.

# Scope

Modify only Docker runtime wiring plus a focused verifier.

## Compose propagation

Preserve the existing internal `DATABASE_URL` used by the clean-machine Compose stack.

Preserve the API container listen port at `3000` and preserve `${API_HOST_PORT:-3000}:3000` as the Compose-only host-publishing contract.

Make the existing API controls externally overrideable while preserving current/default behavior:

- `API_RATE_LIMIT` remains `100` when no Compose-side override is supplied, but an external `API_RATE_LIMIT` value must reach the relevant service environment;
- `API_BODY_LIMIT` must accept an external value; when absent, allow the application config default to remain authoritative rather than introducing another competing default.

Forward the worker/CLI ingestion configuration values from the Compose caller environment into the `worker` service:

- `SOCRATA_APP_TOKEN`
- `INGEST_INTERVAL_MS`
- `ECB_BATCH_SIZE`
- `SOCRATA_PAGE_SIZE`
- `SOCRATA_MAX_PAGES_PER_BATCH`
- `SOCRATA_CONCURRENCY`
- `SOCRATA_REQUEST_TIMEOUT_MS`
- `SOCRATA_MAX_RETRIES`
- `MAX_BATCH_ATTEMPTS_PER_RUN`

For numeric/string ingestion settings, use empty/unset forwarding semantics compatible with the existing `src/config/env.ts` behavior so that application-owned defaults remain authoritative.

Do not expose `SOCRATA_APP_TOKEN` to `api` or `migrate` merely for convenience.

Do not add `API_HOST_PORT` to application/container configuration. It remains host-publishing-only.

## Verification

Add `scripts/verify-runtime-config.mjs`.

The verifier must be deterministic and must not start the full Compose stack merely to inspect resolved environment wiring.

It must use `docker compose config --format json` (or an equivalently structured Compose-config output) under a controlled child environment and prove at least:

1. sentinel overrides for every worker ingestion variable resolve into the `worker` service environment;
2. `SOCRATA_APP_TOKEN` is present in `worker` under an override but absent from `api` and `migrate`;
3. `API_RATE_LIMIT` can be overridden and retains the existing Compose default of `100` when absent;
4. `API_BODY_LIMIT` can be overridden and does not require Compose to own a duplicate application default;
5. the internal Compose `DATABASE_URL` remains unchanged;
6. the API container `PORT` remains `3000`;
7. the published API mapping still uses the existing host-side `API_HOST_PORT` seam and container port `3000`;
8. with the operational variables absent from the verifier child environment, the resolved Compose configuration does not invent duplicate ingestion defaults.

The verifier must not create or rewrite `.env`.

Use an explicit empty temporary Compose env-file or equivalent isolation if needed so a developer's local `.env` cannot make the assertions pass accidentally. Always clean up any temporary file in `finally`.

# Out of scope

Do not:

- change `src/config/**`;
- change `.env.example`;
- change application defaults;
- change scheduler semantics;
- change ingestion behavior;
- change routes or API behavior;
- change the Docker database topology;
- change the evaluator-facing default API host port;
- add new secrets;
- change Harness/provider routing.

# Invariants

- Application config remains the single owner of application defaults.
- Compose performs wiring, not business/default ownership.
- `DATABASE_URL` remains suitable for the Compose-internal PostgreSQL service.
- Container API port remains `3000`.
- `API_HOST_PORT` remains Compose-only.
- Secrets are not broadened to services that do not consume them.
- Normal `docker compose up --build` remains the clean-machine evaluator path.

# Acceptance criteria

1. Setting `INGEST_INTERVAL_MS` in the Compose caller environment changes the worker container's resolved `INGEST_INTERVAL_MS`.
2. The same propagation is proven for all listed worker ingestion controls.
3. Unset ingestion controls continue to fall through to application-owned defaults.
4. API rate/body controls are externally configurable without changing application code.
5. `SOCRATA_APP_TOKEN` is scoped to the worker service.
6. Existing database and API port contracts are unchanged.
7. `node scripts/verify-runtime-config.mjs` passes without starting application containers.
8. Existing focused config tests pass.
9. `npm run verify:api-operations` still passes against the production-shaped Compose runtime.

# Verification

The frontmatter commands are authoritative. Stage 6 repeats the runtime-config verifier and the S4 API/operations gate after merge so the corrected Docker wiring is proven from the integration checkout before S5 begins.
