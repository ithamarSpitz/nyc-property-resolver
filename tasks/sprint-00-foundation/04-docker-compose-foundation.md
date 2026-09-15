---
id: S0-T4
stage: 2
model_class: hard_worker
timeout_minutes: 35
review: true
allow_protected: false
depends_on:
  - S0-T1
allowed_paths:
  - Dockerfile
  - docker-compose.yml
  - .dockerignore
context:
  - architecture.operations
  - architecture.foundations
  - architecture.implementation_map
verification:
  - docker compose config --quiet
---

# Goal

Define the reproducible application image and Compose runtime skeleton with the exact PostgreSQL -> migrate -> API/worker startup dependency chain required by the architecture.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`.

The authoritative runtime ordering is:

`postgres (healthy) -> migrate (completed successfully) -> api + worker`.

The migrate service uses the same application image and runs `npx prisma migrate deploy`.

# Scope

Implement:

- one application `Dockerfile` usable by API, worker, migrate, and later one-off commands;
- `.dockerignore` appropriate for a deterministic Node build context;
- `docker-compose.yml` containing PostgreSQL, migrate, API, and worker services;
- a PostgreSQL healthcheck;
- a persistent PostgreSQL volume for the normal local runtime;
- `migrate` depending on healthy PostgreSQL and exiting after `npx prisma migrate deploy`;
- API and worker depending on successful migration completion;
- the same application image with different commands for API and worker;
- internal container `DATABASE_URL` wiring without committing secrets;
- a host API port suitable for the walkthrough while avoiding unnecessary host exposure of PostgreSQL;
- commands compatible with later `docker compose run --rm worker ...` operations.

This task may reference paths/commands established by S0-T1 and expected Prisma locations from the architecture, but it must not implement DB/domain files owned by S0-T3.

# Out of scope

Do not implement:

- ingestion scheduling or manual-ingestion CLI behavior;
- scale seeding;
- property/ECB domain behavior;
- application config defaults inside Compose when they belong to `src/config`;
- deployment/Kubernetes/cloud infrastructure.

Do not modify package files or Prisma files in this parallel task.

# Invariants

- Migration execution has one owner: the dedicated `migrate` service.
- API and worker do not run migrations themselves.
- The image contains the Prisma CLI needed by the migrate service.
- API and worker share the application image.
- `docker compose up --build` remains the intended clean-machine startup shape.
- Compose does not become a second owner of application defaults.

# Acceptance criteria

1. `docker compose config --quiet` succeeds.
2. Compose expresses `postgres healthy -> migrate success -> api/worker` using dependency conditions rather than timing sleeps.
3. PostgreSQL has a healthcheck and persistent normal-runtime volume.
4. API and worker use the same built image and their stable package commands.
5. PostgreSQL does not require a fixed host port merely for application-container connectivity.
6. No future domain behavior is implemented in Docker configuration.

# Verification

A real build/start/migration/database smoke is intentionally performed only after S0-T2/S0-T3/S0-T4 are integrated, in S0-T5.
