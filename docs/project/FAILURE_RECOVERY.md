# Harness Failure and Recovery Policy

## Task failure

A task gets a bounded attempt budget. An attempt may fail due to agent exit, hard timeout, stall watchdog, scope/protected-path violation, mechanical verification, tests, reviewer rejection or commit failure.

A retry is a fresh Cursor invocation against the existing task worktree, so code survives while the reasoning context is fresh. Exhausting the budget marks the task `BLOCKED` and stops that stage.

Focused recovery later supports running only the blocked task with a different model class, then `resume` continues from the same stage without rerunning DONE or VERIFIED work.

## Stage barrier failure

If task branches are individually VERIFIED but merge/integration verification fails, they remain VERIFIED. The integration checkout rolls back atomically to its pre-stage checkpoint. `rerun-blocker` can retry only the stage barrier without spending coding-agent calls.

## Infrastructure/precondition failure

Invalid roadmap/context, dirty integration checkout, base-ref mismatch, missing tools/environment or Docker setup failures are not coding problems. They stop before unnecessary model calls and record a short failure report with the recovery command.


## Plan gap / architecture change

Do not keep expanding retry budgets when evidence shows the current task/architecture cannot satisfy the requirement. A blocked task can be sent to a read-only plan-repair analyst. The analyst classifies the failure and writes a change request under `.harness/change_requests/`. Architecture/roadmap/task changes are human-gated and must be committed before `plan-change apply`. Apply creates a new plan revision and preserves completed work. Newly added tasks are picked up at their declared stage on the next `resume`; unrelated DONE tasks are skipped.

Affected integrated tasks remain historically DONE but are queued for behavioral revalidation on the integrated checkout before execution can continue. A failed revalidation stops execution and requires a corrective task/plan revision rather than silently reopening merged history.

## Cursor quota exhaustion

Quota exhaustion is operational pause, not implementation failure. The active task becomes `WAITING_FOR_QUOTA`; implementation quota pauses do not consume an attempt. A review-only quota pause resumes at verification/review rather than re-running the coding model. Docker task environments may be torn down while waiting, but worktrees, diffs, state and logs remain.

`quota.policy=wait` keeps the process alive and retries after the configured reset time or conservative probe interval. On Windows the wait period uses a temporary keep-awake request. `quota.policy=stop` exits with state preserved for a later `resume`. The harness never enables on-demand billing.
