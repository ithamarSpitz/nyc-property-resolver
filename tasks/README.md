# Tasks

`tasks/roadmap.yaml` is the executable task graph consumed by the harness.

## Real project status

The first four project sprints have been decomposed into runnable task graphs:

```text
S0-foundation
  Stage 1: S0-T1
  Stage 2: S0-T2, S0-T3, S0-T4 (parallel)
  Stage 3: S0-T5

S1-property-resolution
  Stage 1: S1-T1  property identity/persistence
  Stage 2: S1-T2..S1-T6  normalization + NYC clients (parallel)
  Stage 3: S1-T7  resolver orchestration
  Stage 4: S1-T8, S1-T9  single API + bulk BBL path (parallel)
  Stage 5: S1-T10  integrated resolver behavior gate

S2-ingestion-lifecycle
  Stage 1: S2-T1  ingestion persistence/config/source-identity contracts
  Stage 2: S2-T2..S2-T5  Socrata, retry/limiter, raw+normalization, advisory lock (parallel)
  Stage 3: S2-T6, S2-T7  run initialization + persisted batch processor (parallel)
  Stage 4: S2-T8  executor/resume/fail-stop orchestration
  Stage 5: S2-T9  integrated ingestion-lifecycle behavior gate
S3-ingestion-publication
  Stage 1: S3-T1  live-state promotion/reconciliation primitive
  Stage 2: S3-T2  successful coverage + identifier-version guards
  Stage 3: S3-T3  atomic accepted-run publication
  Stage 4: S3-T4  atomic FAILED/SOURCE_CHANGED publication
  Stage 5: S3-T5  integrated publication semantic gate
```

S5 remains a planning blueprint in `plans/sprints.yaml` and intentionally has no executable task briefs yet.

## Test ownership rule

Behavior-producing tasks own their focused tests. Stage barriers do not create tests; they merge VERIFIED task branches and rerun the relevant integrated suite. S0-T5 is an integration-gate task because the real PostgreSQL/Docker behavior cannot be proven independently by the parallel Stage 2 tasks before they are merged.

## Demo

The `demo` sprint remains available solely for harness self-testing.
