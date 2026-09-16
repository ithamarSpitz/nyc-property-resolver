---
id: S0-T6
stage: 3
model_class: worker
timeout_minutes: 35
review: true
allow_protected: false
depends_on:
  - S0-T1
  - S0-T2
  - S0-T3
  - S0-T4
allowed_paths:
  - src/config/**
  - src/server.ts
  - .env.example
  - docker-compose.yml
  - tests/unit/foundation/config.test.ts
context:
  - architecture.foundations
  - architecture.operations
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/foundation/config.test.ts
  - docker compose config --quiet
---

# Goal

Close CR-0001 by establishing one deterministic API listen-port contract and isolation-safe host publishing before the S0 integration gate runs again.

# Plan-change authorization

CR-0001 explicitly authorizes `PORT` as an implementation-level runtime/configuration contract needed to make the already-authorized Docker host API port real. No `ARCHITECTURE.md` change is required: the architecture environment block is illustrative rather than an exhaustive inventory, and the existing runtime/walkthrough requirements already require a host-reachable API.

Do not invent any unrelated architecture behavior.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`.

The application config remains the single owner of application defaults. Compose supplies environment values and publishing, but does not become a second application-default source.

# Scope

Implement exactly this contract:

- Add `PORT` to the single validated config boundary under `src/config/`.
- The application default for `PORT` is `3000`, owned only by application config.
- Coerce/validate `PORT` as a valid positive TCP port; invalid values fail clearly.
- Wire `src/server.ts` to call `app.listen(getConfig().port, ...)` (or the equivalent existing config accessor) rather than binding an ephemeral port.
- Document `PORT` in `.env.example`.
- Keep the container API port at `3000`.
- Change the Compose host mapping to an overridable form such as `${API_HOST_PORT:-3000}:3000`.
- `API_HOST_PORT` is a Compose-only host-publishing control, not an application config default.
- Add/update focused config tests proving the default `3000` and invalid-value rejection.

The normal evaluator path must remain `docker compose up --build` followed by a host request to `http://localhost:3000/health`.

# Out of scope

Do not implement:

- HTTP middleware or route changes;
- property/ECB behavior;
- ingestion behavior;
- changes to `package.json` start scripts;
- changes to the S0 verification script or `harness.yaml`;
- a second direct `process.env` read in an npm script/entrypoint;
- unrelated Dockerfile changes, including the non-blocking Prisma/OpenSSL warning.

# Invariants

- Application config is the only owner of the API listen-port default.
- Compose may supply `PORT=3000` but does not own a competing application default.
- `src/server.ts` listens explicitly on the validated configured port.
- Container port remains `3000`.
- Default host publishing remains `3000:3000` for the evaluator walkthrough.
- Verification can override only the host side (`API_HOST_PORT=0`) to obtain an ephemeral host port.
- No npm-script monkey-patch or entrypoint workaround is permitted.

# Acceptance criteria

1. Config tests prove `PORT` defaults to `3000` and rejects invalid port values.
2. `src/server.ts` binds the validated configured port explicitly.
3. `.env.example` documents `PORT`.
4. `docker compose config --quiet` succeeds with the default host mapping.
5. `API_HOST_PORT=0 docker compose ...` (or cross-platform equivalent environment injection) permits Docker to allocate an ephemeral host port while the container still listens on `3000`.
6. The normal default Compose path still exposes API container port 3000 on host port 3000 when that host port is free.
7. No unrelated runtime/configuration behavior is changed.

# Verification

The harness runs the frontmatter commands independently and repeats the same commands as the Stage 3 barrier before S0-T5.
