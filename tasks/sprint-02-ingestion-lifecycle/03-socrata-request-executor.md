---
id: S2-T3
stage: 2
model_class: worker
timeout_minutes: 40
review: true
allow_protected: false
depends_on:
  - S2-T1
allowed_paths:
  - src/clients/socrata-request-executor.ts
  - tests/unit/clients/socrata-request-executor.test.ts
context:
  - architecture.ingestion_strategy
  - architecture.operations
verification:
  - npm run typecheck
  - npm test -- --runInBand tests/unit/clients/socrata-request-executor.test.ts
---

# Goal

Implement the bounded Socrata request-execution primitive that owns Bottleneck concurrency/pacing, per-request timeout, and transient HTTP retry behavior without conflating those retries with logical ingestion-batch attempts.

# Required context

Read only the context aliases listed in the frontmatter plus `AGENTS.md` and the S2-T1 validated ingestion configuration.

# Scope

Implement a reusable ECB Socrata request executor that:

- creates/configures Bottleneck using `SOCRATA_CONCURRENCY` and any configured pacing value supported by the existing config contract;
- executes supplied Socrata request operations through the limiter;
- applies `SOCRATA_REQUEST_TIMEOUT_MS` with `AbortController`/native cancellation;
- retries only errors classified as transient/retryable;
- enforces `SOCRATA_MAX_RETRIES` as the retry bound for one HTTP request;
- records/returns retry-call accounting so ingestion run metrics can distinguish baseline requests from retries;
- propagates caller abort signals so advisory-lock authority loss can stop pending/new source work;
- never owns `MAX_BATCH_ATTEMPTS_PER_RUN` or modifies ingestion batch state.

Use deterministic/fake timers or injected sleep/backoff behavior in tests so retry tests are fast and stable.

# Out of scope

Do not implement:

- Socrata query construction;
- database/run/batch persistence;
- logical batch attempt loops;
- raw/domain normalization;
- advisory-lock acquisition itself;
- unbounded exponential retry behavior.

# Invariants

- Every external Socrata request passes through bounded concurrency/pacing.
- HTTP retries and logical batch attempts remain separate counters/limits.
- Cancellation from the ingestion executor prevents new retry/request work.
- A configuration change cannot create unbounded concurrency or unbounded retry loops.

# Acceptance criteria

1. Concurrency never exceeds the configured `SOCRATA_CONCURRENCY` in the test harness.
2. Retryable failures are retried only up to the configured request-retry bound.
3. Non-retryable failures are returned immediately without consuming the full retry budget.
4. Request timeout aborts the operation and is surfaced distinctly from successful/HTTP responses.
5. An external abort signal stops pending/retry work and no new request is scheduled afterward.
6. Tests prove retry-call accounting is separate from a logical batch-attempt count.

# Verification

Only deterministic unit tests are required; logical batch-attempt behavior is owned by S2-T7.
