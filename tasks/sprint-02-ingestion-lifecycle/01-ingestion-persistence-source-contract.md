---
id: S2-T1
stage: 1
model_class: hard_worker
timeout_minutes: 60
review: true
allow_protected: false
depends_on: []
allowed_paths:
  - prisma/schema.prisma
  - prisma/migrations/**
  - src/config/env.ts
  - .env.example
  - src/schemas/ecb-ingestion.schema.ts
  - src/services/ecb/ingestion-run.repository.ts
  - src/services/ecb/ingestion-batch.repository.ts
  - src/services/ecb/source-contract.service.ts
  - tests/unit/ingestion/source-contract.test.ts
  - tests/integration/ingestion/ingestion-persistence.test.ts
context:
  - architecture.ingestion_lifecycle
  - architecture.storage
  - architecture.data_access_validation
environment: docker
verification:
  - npx prisma validate
  - npm run typecheck
  - npm test -- --runInBand tests/unit/ingestion/source-contract.test.ts
  - docker compose build
  - docker compose up -d postgres
  - docker compose run --rm migrate
  - docker compose run --rm --no-deps worker npm test -- --runInBand tests/integration/ingestion/ingestion-persistence.test.ts
---

# Goal

Establish the durable S2 ingestion persistence/configuration contracts: ingestion runs, immutable run Property<->BIN snapshots, immutable batch definitions, raw/staging source versions, bounded operational configuration, and the explicit DOB ECB source-identity contract used by every later ingestion task.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md` and the already-integrated S1 property/coverage schema.

Pay particular attention to:

- one active ingestion run per dataset;
- durable `QUEUED` initialization state and the start-watermark state invariant;
- `property_identifier_version` being captured in the run snapshot;
- immutable `batch_definition` per run/batch number;
- raw identity `(source_id, source_row_updated_at)` and staging identity `(run_id, source_id)`;
- `ISN_DOB_BIS_EXTRACT` being a source-key assumption that must be verified explicitly rather than silently trusted;
- HTTP retries and logical batch attempts having separate bounds.

# Scope

Implement the Prisma/migration/config/repository foundation required by S2:

- `ingestion_runs` with the lifecycle/metrics fields required by the architecture;
- PostgreSQL partial unique enforcement allowing at most one `QUEUED`/`RUNNING` run per dataset;
- database/application state constraints required for `RUNNING`/`COMPLETED`/`SOURCE_CHANGED` start-watermark invariants;
- `ingestion_run_property_bins` with snapshotted `property_identifier_version`;
- `ingestion_batches` with immutable logical `batch_definition`, progress and `attempt_count` fields;
- `ecb_violation_raw` with required provenance/system-row fields and `(source_id, source_row_updated_at)` uniqueness;
- `ecb_violation_staging` with run-scoped uniqueness and `(run_id, bin)` indexing;
- S2 operational configuration in the existing Zod env boundary and `.env.example` for:
  - `ECB_BATCH_SIZE`;
  - `SOCRATA_PAGE_SIZE`;
  - `SOCRATA_MAX_PAGES_PER_BATCH`;
  - `SOCRATA_CONCURRENCY`;
  - `SOCRATA_REQUEST_TIMEOUT_MS`;
  - `SOCRATA_MAX_RETRIES`;
  - `MAX_BATCH_ATTEMPTS_PER_RUN`;
  - `INGEST_INTERVAL_MS`;
  with architecture defaults/bounds where defined;
- typed run/batch repository primitives used by later services, with transaction-aware methods rather than ad-hoc SQL in services;
- a source-contract service/query definition that treats `ISN_DOB_BIS_EXTRACT` as the proposed source id, depends only on a minimal reader/port (not the future concrete Socrata client), and can verify:
  - total row count;
  - distinct `ISN_DOB_BIS_EXTRACT` count;
  - NULL count;
  - duplicate groups;
- explicit constants/types for `socrata_row_id = :id` and `source_row_updated_at = :updated_at` without using `ECB_VIOLATION_NUMBER` as ingestion identity.

Where Prisma cannot express a required PostgreSQL partial index/check directly, commit deterministic SQL in the migration rather than weakening the invariant.

# Out of scope

Do not implement:

- Socrata HTTP fetching;
- Bottleneck/retry execution;
- ECB domain normalization;
- advisory-lock acquisition;
- run initialization orchestration;
- batch processing/resume loops;
- live `ecb_violations` promotion/reconciliation;
- property coverage failure/success publication;
- scheduler/manual ingestion CLI.

Do not add a live normalized-table publication path in S2-T1; S3 owns accepted live-state publication.

# Invariants

- At most one active `QUEUED`/`RUNNING` run exists per dataset.
- Logical identity columns participating in S2 uniqueness constraints are non-null as required by the architecture.
- Raw source versions are unique by `(source_id, source_row_updated_at)`.
- Staging candidates are unique by `(run_id, source_id)`.
- Run snapshot rows capture `property_identifier_version` and are immutable after initialization.
- Batch definitions are durable data, not reconstructed process memory.
- Operational loop/retry/page bounds come from validated config rather than literals in services.
- `ISN_DOB_BIS_EXTRACT` is not silently promoted to a trusted business key without an explicit verification result.

# Acceptance criteria

1. Prisma validation and the committed migration create all S2 persistence tables/constraints/indexes required for lifecycle/raw/staging work.
2. A real PostgreSQL integration test proves the partial active-run uniqueness rule.
3. A real PostgreSQL integration test proves duplicate raw source versions and duplicate run/source staging candidates cannot create duplicate logical rows.
4. Snapshot rows persist the property's identifier version and batch definitions round-trip without recomputation.
5. Invalid ingestion configuration is rejected by the existing Zod config boundary and valid defaults are typed.
6. The source-contract unit test proves the verification result distinguishes valid uniqueness from NULL/duplicate-key violations, does not substitute `ECB_VIOLATION_NUMBER` as source identity, and compiles without importing a not-yet-built concrete Socrata client.
7. Repository primitives are transaction-aware and do not encode S3 promotion/coverage behavior prematurely.

# Verification

The focused unit test validates the proposed source-key contract; the integration test validates actual PostgreSQL lifecycle/raw/staging constraints. No live Socrata call is required.
