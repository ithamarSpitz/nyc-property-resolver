---
id: S0-T3
stage: 2
model_class: hard_worker
timeout_minutes: 35
review: true
allow_protected: false
depends_on:
  - S0-T1
allowed_paths:
  - prisma/**
  - src/db/**
context:
  - architecture.foundations
  - architecture.data_access_validation
  - architecture.implementation_map
verification:
  - npx prisma validate
  - npx prisma generate
  - npm run typecheck
---

# Goal

Establish the PostgreSQL/Prisma schema, client, and migration workflow foundation without prematurely implementing S1/S2 domain tables.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md`.

Pay particular attention to Prisma being the primary application data layer, PostgreSQL being the persistent source of truth, migrations being committed/reproducible, and the dedicated `pg` connection being reserved for later advisory-lock ownership rather than replacing Prisma generally.

# Scope

Implement:

- `prisma/schema.prisma` configured for PostgreSQL and Prisma Client generation;
- the migration-directory baseline needed for a deterministic `prisma migrate deploy` workflow, without inventing unrelated application tables;
- a small `src/db/prisma.ts` application database boundary suitable for later services/tests;
- predictable client lifecycle suitable for API/worker processes and automated tests;
- any minimal generated-client setup needed by the repository build.

If an empty/baseline migration is not meaningful for the installed Prisma version, keep the migration directory/workflow valid and let S1 create the first domain migration. Do not create a fake health/domain table merely to force a migration.

# Out of scope

Do not implement:

- `properties`, `property_bins`, coverage, ECB, run, batch, raw, staging, or live domain models;
- advisory-lock logic;
- repository/service methods for future domains;
- Docker configuration;
- application behavior tests that require tables which do not yet exist.

# Invariants

- PostgreSQL is the target database.
- Prisma remains the primary schema/migration/data-access layer.
- Domain schema changes will be represented as committed migrations in later tasks.
- No fake table is added solely to make a smoke test pass.
- Long-lived ingestion advisory locking will later use a dedicated `pg` session, not a Prisma query pretending to own the session.

# Acceptance criteria

1. `npx prisma validate` passes.
2. `npx prisma generate` succeeds from the committed schema.
3. Application code imports Prisma through the shared DB boundary rather than constructing clients throughout the codebase.
4. The repository is ready for S1 to add its first real schema migration without replacing the foundation.
5. No S1/S2 domain model has been implemented early.

# Verification

Database connectivity and migration deployment against a real PostgreSQL container are deliberately deferred to S0-T5, after the Docker task has been merged. This task verifies the Prisma contract itself.
