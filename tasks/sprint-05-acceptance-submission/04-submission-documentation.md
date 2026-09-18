---
id: S5-T4
stage: 9
model_class: hard_worker
timeout_minutes: 75
review: true
allow_protected: false
depends_on:
  - S5-T12
allowed_paths:
  - README.md
  - DESIGN.md
  - RUN_LOG.md
context:
  - assignment
  - architecture.ingestion_strategy
  - architecture.storage
  - architecture.operations
  - architecture.implementation_map
  - architecture.testing
environment: docker
verification:
  - >-
    node -e "const fs=require('fs'); for (const f of ['README.md','DESIGN.md','RUN_LOG.md']) if (!fs.existsSync(f)) process.exit(1)"
  - git diff --check
---

# Goal

Turn the implemented system and measured S5 evidence into the concise submission documents the evaluator asked for, without changing code or inventing results.

# Required context

Read the listed authoritative contexts, the final integrated implementation, `evidence/acceptance-small/**`, `evidence/scale-10000/**`, and the checked-in seed files.

# Scope

Create the final repository-root `README.md`, `DESIGN.md`, and `RUN_LOG.md`.

## README.md

Keep it approximately one page and optimize for the evaluator's first ten minutes. It must include:

- prerequisites consistent with the assignment's clean Docker-machine expectation;
- the single clean-start command (`docker compose up --build` or the exact supported equivalent);
- environment/config instructions, including how to change the ingestion interval and provide an optional Socrata token without committing it;
- the exact manual ingestion command;
- all required API endpoints with one concise example request and representative response each;
- coverage/freshness explanation showing checked-empty vs not-checked vs failed;
- a deterministic Empire State walkthrough from property registration through local ECB query;
- where the 5–8 seed file lives and how to run the acceptance path;
- the two BIS spot-check outcome summaries, based strictly on S5-T2 evidence;
- the measured 10k headline results with a pointer to RUN_LOG/evidence.

## DESIGN.md

Keep it roughly one to two pages of dense engineering rationale and cover:

- implemented watchlist strategy and why it was chosen;
- the rejected whole-dataset mirror strategy;
- arithmetic using the actual measured 10k property/BIN/call/row results plus a clearly labelled 20k extrapolation;
- the 1-NYC-data-point vs 10-data-point switch discussion and what evidence would trigger a mirror/CDC-style redesign;
- storage layout and important keys, including raw vs staging vs accepted live state;
- idempotency and source identity;
- durable run/batch resume semantics and explicit bounds;
- advisory-lock/fail-stop ownership;
- promotion, negative reconciliation and SOURCE_CHANGED semantics;
- coverage/freshness and identifier-version guards;
- what comes next: second data point, change alerts, and the first refactor only after a second concrete source proves the shared abstraction.

Do not restate every implementation detail. Explain the decisions and trade-offs.

## RUN_LOG.md

Create a readable index/summary that points to the raw evidence and reports:

- baseline small-run command/run ID/timing/status/counts;
- immediate idempotent second-run command/run ID/timing/status and duplicate audit result;
- BIS comparison summary with links/paths to exact evidence records;
- 10k scale sample definition, command, run ID and every required metric;
- any observed retries/failures with explanation rather than omission.

Do not paste huge console logs into Markdown; link to the committed raw log files.

# Out of scope

Do not:

- alter source code, Docker files, migrations, tests, seeds or evidence;
- manufacture cleaner benchmark/BIS numbers than the evidence contains;
- claim exact future 20k timing as measured — mark extrapolation as extrapolation;
- add stretch goals as if they were implemented;
- exceed the assignment's requested communication scope with a long architecture novel.

# Invariants

- Evidence-backed facts cite repository evidence paths/run IDs.
- README commands match the real package/Compose commands exactly.
- DESIGN distinguishes measured results, calculations and future proposals.
- No secret/token value appears in documentation.
- The evaluator can understand why query endpoints never call Socrata at request time.

# Acceptance criteria

1. README provides a deterministic clean-machine startup, configuration, manual trigger and API walkthrough using actual commands.
2. README includes one example request/response for every required API behavior and explicitly explains coverage states.
3. DESIGN contains the requested strategy/storage/idempotency/failure/freshness/next-step argument and quantitative 10k/20k plus 1-vs-10-data-point reasoning.
4. RUN_LOG indexes the exact baseline, idempotent and scale raw evidence and reproduces all required measured metrics accurately.
5. BIS and benchmark statements match the committed evidence; discrepancies are reported, not hidden.
6. Documentation remains concise enough for the planned 45-minute walkthrough.

# Verification

Reviewer must cross-check numerical/documented claims against the evidence files, not merely proofread the prose. The next task will execute an adversarial clean-checkout gate against these instructions.
