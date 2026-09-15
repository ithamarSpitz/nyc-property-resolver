# Verification Plan

Machine-readable matrix: `plans/verification-matrix.yaml`.

## Completion layers

1. **Task verification** — focused tests, typecheck when available, diff/scope checks, independent review as required.
2. **Stage barrier** — atomically merge every VERIFIED branch in the stage and run cross-task integration verification; rollback the whole stage on failure.
3. **Sprint exit gate** — prove the sprint-level architectural contract before the next sprint begins.
4. **Final acceptance** — clean Docker runtime, real seed, idempotent second run, BIS evidence and 10k scale run.

The coding agent's statement that tests pass is advisory only; the harness re-runs configured checks.

External NYC APIs are mocked in automated tests. Real NYC calls belong to acceptance/scale verification, not ordinary retries.
