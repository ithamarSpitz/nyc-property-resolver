# Sprint Blueprint

This document fixes sprint and stage boundaries so task briefs can be generated without re-deciding architecture. Machine-readable source: `plans/sprints.yaml`. **S0 through S5 now have executable task graphs in `tasks/roadmap.yaml`; the complete project plan is runnable.**

## S0 — Foundation

Executable decomposition now exists:

```text
Stage 1: S0-T1 toolchain/test foundation
Stage 2: S0-T2 config/logging || S0-T3 Prisma/Postgres || S0-T4 Docker/Compose
Stage 3: S0-T5 integrated foundation gate
```

Repository/toolchain → parallel config/database/container foundations → foundation integration gate.

Exit only when a clean checkout can install/build/test and the Compose migration chain is valid.

## S1 — Property Resolution

Identity/persistence contracts → parallel resolver primitives/NYC clients → resolver orchestration/conflict handling → registration API + bulk path → behavior gate.

Key barrier: effective BIN mutation, `identifier_version`, and coverage invalidation must already have one transactional owner before resolver/API work can publish identity changes.

## S2 — Ingestion Lifecycle

Ingestion persistence/source identity → parallel Socrata/request-executor/raw-normalization/lock primitives → parallel crash-safe run initialization + persisted-batch processor → resume/attempt/fail-stop executor orchestration → lifecycle integration gate.

Key barrier: resume semantics are not built on current live watchlist state; persisted run snapshot and batch definitions are immutable.

## S3 — Ingestion Publication

Live-state promotion/reconciliation → success coverage/version guards → atomic accepted publication → atomic terminal failure publication → full semantic gate.

Key barrier: accepted live state and failure state cannot partially publish.

## S4 — API & Operations

Parallel query/pagination + scheduler/logging/security/config foundations → API endpoints → Docker migration/startup gate → full service integration.

Key barrier: query paths remain local-store-only and keyset pagination handles `issue_date IS NULL` exactly as specified.

## S5 — Acceptance & Submission

Acceptance fixtures/tooling → real-data baseline/BIS/idempotency evidence → 10k scale evidence → README/DESIGN/RUN_LOG from measured evidence → adversarial clean-repository final gate.

Expensive real-data/scale verification is intentionally isolated here so ordinary coding retries never repeat it.
