---
id: S3-T5
stage: 5
model_class: hard_worker
timeout_minutes: 80
review: true
allow_protected: false
depends_on:
  - S3-T4
allowed_paths:
  - package.json
  - src/services/ecb/ingestion-runner.service.ts
  - scripts/verify-ingestion-publication.mjs
  - tests/integration/ingestion/ingestion-publication.behavior.test.ts
context:
  - architecture.ingestion_lifecycle
  - architecture.storage
  - architecture.testing
environment: docker
verification:
  - npm run verify:ingestion-publication
---

# Goal

Establish the complete S3 semantic gate by composing the existing S2 executor with the concrete S3 success/failure publishers and proving that every run ends with one coherent accepted-or-rejected database state, never a hybrid.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md` and the already-integrated S2/S3 services.

# Scope

Create the production-facing application composition boundary for ingestion publication and one reproducible verification gate:

- implement `ingestion-runner.service.ts` (or an equivalently narrow application service) that:
  - executes the S2 ingestion executor with the concrete S3 terminal publisher;
  - when S2 returns `READY_FOR_PUBLICATION`, invokes the S3 accepted-publication service;
  - returns a typed final run outcome without implementing scheduler timing or CLI argument parsing;
- create cross-platform `scripts/verify-ingestion-publication.mjs` and `npm run verify:ingestion-publication` that run the full S2+S3 semantic suite in isolated Docker/PostgreSQL and clean resources on success/failure;
- add integrated behavior tests proving at minimum:
  - Run A successful promotion establishes live state and `CHECKED` coverage;
  - repeated successful ingestion/upsert remains logically idempotent;
  - Run B with `SOURCE_CHANGED` leaves Run A live state exactly intact, performs no negative reconciliation, marks eligible latest attempts failed, and preserves Run A as last success;
  - terminal FAILED after committed scope preserves accepted live state/last success while publishing eligible failure attempt metadata atomically;
  - pre-scope terminal failure is visible at run level without falsely marking every property FAILED;
  - identifier-version change after snapshot prevents both stale success and stale failure publication for the newer property state;
  - successful run coverage derives from the immutable run snapshot, not current live `property_bins`;
  - negative reconciliation occurs only for an accepted run and only for the accepted run's scanned BIN scope;
  - transaction-failure seams cannot leave live rows/coverage/run terminal state partially published;
  - lock/execution-authority loss does not allow accepted or terminal publication from the superseded executor.

If the gate uncovers an earlier task-owned defect, stop with a precise Task/Stage failure or plan-change request rather than silently broadening this gate into a rewrite task.

# Out of scope

Do not implement:

- S4 HTTP query endpoints/pagination;
- scheduler interval or reviewer-facing manual ingestion CLI;
- real NYC network acceptance;
- BIS spot checks;
- 10k scale run;
- generic multi-dataset ingestion framework.

# Invariants

- Live normalized ECB state always corresponds to the last accepted run.
- A failed or SOURCE_CHANGED run never exposes staging as live state and never performs negative reconciliation.
- Success/failure coverage publication is version-guarded against the run snapshot.
- Run terminal state and the coverage/live mutations belonging to that terminal outcome cannot diverge across crash/rollback windows.
- Automated S3 verification is deterministic and does not depend on live NYC APIs.

# Acceptance criteria

1. `npm run verify:ingestion-publication` passes from an integrated S3 checkout with Docker available.
2. A successful run atomically establishes live rows/reconciliation/success coverage/`COMPLETED` state.
3. A later `SOURCE_CHANGED` or FAILED run leaves the previously accepted live state and `last_success_*` intact while publishing only eligible attempt failure semantics.
4. Repeated accepted ingestion does not create duplicate logical live rows.
5. Properties whose `identifier_version` changed after snapshot are protected from stale success and stale failure coverage writes.
6. Pre-scope failures mutate no property coverage; post-scope failures use the immutable run snapshot for attribution.
7. Injected failures at publication boundaries prove there is no durable hybrid state.
8. Verification cleans temporary Compose resources/volumes on success and failure.

# Verification

This is the S3 behavior gate. It uses real PostgreSQL and deterministic mocked NYC/Socrata data through the existing S2 test seams; real-data acceptance remains S5.
