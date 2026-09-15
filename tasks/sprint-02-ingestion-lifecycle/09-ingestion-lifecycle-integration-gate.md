---
id: S2-T9
stage: 5
model_class: hard_worker
timeout_minutes: 75
review: true
allow_protected: false
depends_on:
  - S2-T8
allowed_paths:
  - package.json
  - src/cli/verify-ecb-source-contract.ts
  - scripts/verify-ingestion-lifecycle.mjs
  - tests/fixtures/ingestion/**
  - tests/integration/ingestion/ingestion-lifecycle.behavior.test.ts
context:
  - architecture.ingestion_strategy
  - architecture.ingestion_lifecycle
  - architecture.storage
  - architecture.testing
environment: docker
verification:
  - npm run verify:ingestion-lifecycle
---

# Goal

Establish one reproducible S2 behavior gate proving the complete durable ingestion lifecycle through the S3 publication handoff: source/query contracts, raw-before-normalized staging, crash-safe initialization, persisted-batch resume, bounded retries/pages/attempts, and dedicated-session fail-stop authority.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md` and the already-integrated S2 implementation.

# Scope

Create a cross-platform `scripts/verify-ingestion-lifecycle.mjs` and `npm run verify:ingestion-lifecycle` that run the integrated S2 suite in an isolated Docker/PostgreSQL environment and clean resources on success/failure.

The gate must prove, with deterministic mocked Socrata data unless explicitly stated otherwise:

- Prisma/config/typecheck prerequisites;
- one active-run uniqueness and valid lifecycle persistence constraints;
- source contract logic for `ISN_DOB_BIS_EXTRACT` and explicit `:id/:updated_at` query selection;
- raw-before-strict-validation and raw/staging replay idempotency;
- durable `QUEUED` run creation;
- crash during Property<->BIN snapshot/batch initialization leaves no partial initialized state;
- metadata failure after committed initialization follows the terminal-publication port path;
- crash after start watermark fetch but before persistence leaves initialized QUEUED + NULL watermark and retries safely;
- immutable Property<->BIN snapshot and immutable batch definitions despite live watchlist changes;
- resume never reloads/repartitions the live watchlist;
- completed batches are skipped; partial batches restart from page 1;
- request retry limits are distinct from logical batch-attempt limits;
- page-limit and attempt-exhaustion terminal outcomes;
- advisory-lock competition and lock-session-loss fail-stop behavior;
- matching start/end watermark produces `READY_FOR_PUBLICATION` without touching live `ecb_violations`/coverage;
- changed watermark produces a `SOURCE_CHANGED` publication decision and no batch reuse/promotion.

Also add a manual source-contract CLI entrypoint (`src/cli/verify-ecb-source-contract.ts`, with an npm script if appropriate) that can run the explicit NYC source-key probe when credentials/network are available. The automated S2 gate must **not** require the live NYC network; the CLI exists so the source assumption can be verified explicitly before a production-style real ingestion/acceptance run.

# Out of scope

Do not implement:

- S3 live `ecb_violations` table/promotion;
- negative reconciliation;
- property coverage success/failure publication;
- final COMPLETED publication;
- scheduled worker interval/manual ingestion command used by reviewers;
- real NYC acceptance or 10k scale execution.

If the integrated gate exposes a defect in an earlier task-owned path, stop with a precise Task/Stage failure or plan change rather than silently broadening this gate to rewrite the component.

# Invariants

- Automated S2 verification does not depend on NYC network availability.
- PostgreSQL transaction/lock/resume semantics are exercised against real PostgreSQL.
- The live accepted ECB state is not changed anywhere in S2.
- The source-contract CLI is explicit/manual evidence and is not silently executed on every retry/test run.
- Docker cleanup occurs on success and failure.

# Acceptance criteria

1. `npm run verify:ingestion-lifecycle` passes from an integrated S2 checkout with Docker available.
2. The gate exercises the architecture's crash/restart, immutable snapshot/batch, request-vs-batch retry, page-bound, and lock-loss behaviors against real PostgreSQL.
3. Resume after a watchlist change still uses only the original persisted run snapshot/batch definitions.
4. A partially processed batch replay starts at page 1 and produces no duplicate raw/staging logical records.
5. Lock-session loss aborts execution even while the ordinary application DB layer can remain available.
6. The integrated lifecycle stops at a typed S3 publication decision and proves that no accepted live state/coverage was mutated.
7. The explicit source-contract CLI can report total/distinct/null/duplicate evidence without introducing a second Socrata implementation.
8. Verification leaves no temporary Compose resources/volumes behind after exit.

# Verification

This task is the S2 behavior gate. The Harness reruns `npm run verify:ingestion-lifecycle` after the task is merged into the Stage-5 integration checkout.
