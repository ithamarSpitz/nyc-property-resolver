---
id: S5-T2
stage: 2
model_class: hard_worker
timeout_minutes: 120
review: true
allow_protected: false
depends_on:
  - S5-T1
allowed_paths:
  - evidence/acceptance-small/**
context:
  - assignment
  - architecture.testing
  - architecture.operations
environment: docker
verification:
  - npm run acceptance:small:validate-evidence
---

# Goal

Execute the real small-property acceptance workflow, perform the required BIS spot checks, and commit auditable baseline/idempotency evidence without modifying implementation code.

# Required context

Read only the listed context aliases plus `AGENTS.md`, the S5-T1 seed/tooling contract, and the already-integrated application.

# Scope

Use a clean S5 Compose state and the S5-T1 runner to perform the actual real-network acceptance sequence.

The evidence must show, in order:

1. clean Docker start and service health;
2. live `ISN_DOB_BIS_EXTRACT` source-contract probe results before production-style ECB ingestion;
3. resolution/registration of every small seed entry, including canonical property IDs, BBLs, valid BIN sets and coverage before ingestion;
4. baseline manual ingestion via `docker compose run --rm worker npm run ingest:ecb` (or the exact equivalent created by S4), with complete console log, run ID/status, start/end dataset watermarks and failure summary;
5. local API snapshots for the seeded properties, including Empire State and the unpaid-balance case;
6. at least two BIS Property Profile spot checks against the canonical human view, recording the exact property/BIN checked, UTC timestamp, BIS URL/page identity, what field/count/status was compared, the local value, the BIS-observed value, and whether they matched;
7. a second immediate ingestion using the same watchlist and normal ingestion path;
8. an idempotency audit proving no duplicate logical live rows/raw source versions were introduced and recording any expected updates separately from duplicates;
9. the second complete console log and final coverage/run summary.

Store raw logs and machine-readable summaries under `evidence/acceptance-small/`. Do not replace raw evidence with prose-only conclusions.

BIS verification is an external/manual acceptance dependency. If BIS is unavailable, blocks access, or the evidence cannot be observed reliably, stop with a precise external-verification failure. Do **not** claim a match based on Socrata, cached memory, or another website as a substitute for BIS.

If the live run reveals an implementation defect, this task must fail and identify the owning S0–S4 contract. The only files this task may commit are evidence files; implementation repair requires focused recovery/plan repair.

# Out of scope

Do not:

- edit source code, migrations, Docker configuration, tests, or acceptance tooling;
- choose replacement fixtures just because a required fixture exposes a bug;
- run the 10,000-property benchmark;
- write final README/DESIGN prose;
- fabricate a BIS result when the site cannot be checked;
- commit tokens/secrets in logs (redact secret values while preserving useful request/run metadata).

# Invariants

- The two ingestion runs use the same real application path and persisted watchlist.
- The second run is evidence of idempotency, not a fresh reset of the database.
- All ECB query screenshots/JSON/logged responses used for acceptance come from the local API after ingestion.
- `last_success`/coverage evidence remains consistent with the accepted live run semantics built in S3.
- Evidence records exact timestamps and source/run identifiers so later documentation can cite facts rather than estimates.

# Acceptance criteria

1. Every required small seed resolves or the task fails with preserved diagnostic evidence.
2. The source-key probe is recorded and does not show a contract violation that would make `ISN_DOB_BIS_EXTRACT` unsafe as the durable source key.
3. Baseline ingestion reaches an accepted terminal state and local API results/coverage are captured.
4. At least two genuine BIS spot checks are recorded with reproducible page/property identity and explicit local-vs-BIS comparison.
5. The immediate second run completes safely and the duplicate audit demonstrates logical idempotency.
6. Baseline and second-run raw console logs are both retained.
7. `npm run acceptance:small:validate-evidence` rejects incomplete evidence and passes the committed evidence set.
8. No S0–S4 implementation file changes in this task.

# Verification

The Harness verifier validates the committed evidence; it does not rerun the external acceptance a third time. Reviewer inspection must treat missing provenance/raw logs as failure, not as a documentation nit.
