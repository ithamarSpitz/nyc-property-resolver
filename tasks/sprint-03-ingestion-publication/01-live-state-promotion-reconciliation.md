---
id: S3-T1
stage: 1
model_class: hard_worker
timeout_minutes: 65
review: true
allow_protected: false
depends_on: []
allowed_paths:
  - prisma/schema.prisma
  - prisma/migrations/**
  - src/services/ecb/live-state.repository.ts
  - tests/integration/ingestion/live-state-promotion.test.ts
context:
  - architecture.ingestion_lifecycle
  - architecture.storage
  - architecture.testing
environment: docker
verification:
  - npx prisma validate
  - npm run typecheck
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/ingestion/live-state-promotion.test.ts
---

# Goal

Create the accepted live ECB storage primitive: add the live `ecb_violations` persistence contract and implement transaction-aware staging promotion plus negative reconciliation scoped only to the immutable BIN set actually scanned by the accepted run.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md` and the already-integrated S1/S2 schema/services.

# Scope

Implement the live normalized-state schema/repository primitive required by S3:

- add `ecb_violations` with the architecture fields required for accepted normalized state, including:
  - non-null `source_id` logical identity;
  - `socrata_row_id`;
  - `bin`;
  - normalized domain fields already represented in staging;
  - `source_row_updated_at`;
  - non-null `last_success_run_id`;
  - `is_current`;
  - timestamps used by persistence;
- enforce `UNIQUE(source_id)` and the required BIN index; defer query-specific S4 indexes unless already justified by the schema contract;
- implement a transaction-aware `live-state.repository.ts` primitive that receives an existing Prisma transaction/client and a run id, and:
  1. UPSERTs every staging candidate for run `R` into `ecb_violations`;
  2. sets promoted rows to `last_success_run_id=R` and `is_current=true`;
  3. derives the negative-reconciliation BIN scope from the persisted `ingestion_run_property_bins` snapshot for `R`, never from current live `property_bins`;
  4. for those fully scanned run-snapshot BINs, marks previously-live rows `is_current=false` when their source identity is absent from staging for `R`;
- keep the primitive free of its own outer transaction so S3-T3 can compose promotion, reconciliation, successful coverage and `COMPLETED` in one atomic database transaction.

# Out of scope

Do not implement:

- successful property coverage publication;
- run `COMPLETED` transition;
- FAILED/SOURCE_CHANGED publication;
- API query/filter/pagination logic or query-specific indexes owned by S4;
- cleanup/deletion of raw or staging history;
- current portfolio-membership filtering; `is_current` is source-current state, not tracked-watchlist membership.

# Invariants

- `ecb_violations` represents only the last accepted live normalized source state.
- Promotion is idempotent by `source_id`; repeated upsert of the same accepted candidate cannot create duplicates.
- Negative reconciliation is bounded to BINs actually scanned in the run snapshot.
- Reconciliation never uses current live `property_bins` to redefine the run's scope.
- Rows outside the accepted run's scanned BIN scope are not marked non-current.
- This primitive never commits independently from the higher-level accepted-publication transaction.

# Acceptance criteria

1. The migration creates `ecb_violations` with non-null logical identity, `UNIQUE(source_id)`, BIN indexing, `last_success_run_id`, and `is_current` semantics required by the architecture.
2. Promoting staging for run `R` inserts new rows and updates existing `source_id` rows without duplicates, setting `last_success_run_id=R` and `is_current=true`.
3. A previously-current row for a BIN included in `R`'s immutable run snapshot becomes `is_current=false` when it is absent from `R` staging.
4. A live row belonging to a BIN outside `R`'s run-snapshot scope remains untouched even if absent from staging.
5. Changing current `property_bins` after the run snapshot does not change reconciliation scope.
6. Replaying the repository primitive inside a rolled-back/test transaction remains deterministic and does not require network access.

# Verification

The integration test uses real PostgreSQL and explicit run-snapshot/staging fixtures. It validates the live schema, upsert behavior and negative-reconciliation scope without publishing coverage or run terminal state.
