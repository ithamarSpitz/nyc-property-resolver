# Change Control After Execution Starts

The original roadmap is not immutable reality, but changing it must be explicit and auditable.

## Trigger

After bounded retries/focused recovery, use plan repair when evidence shows either:

- a missing prerequisite/corrective task (`TASK_ADDITION`), or
- a real conflict with the authoritative architecture (`ARCHITECTURE_CHANGE`).

`IMPLEMENTATION_ONLY` means keep the current plan and use focused implementation recovery. `UNKNOWN` requires human investigation.

## Flow

```text
BLOCKED task
  -> read-only plan-change proposal
  -> human review
  -> edit + commit architecture/roadmap/task files
  -> plan-change apply
  -> validation/context-drift checks
  -> plan revision N+1
  -> affected blocked work reset with fresh budget
  -> affected DONE work queued for revalidation
  -> resume from earliest unfinished stage
```

The planner never edits protected files. Applying a change refuses to remove a task that already has runtime history; supersede it with corrective work or keep/revise its dependency contract.

Every revision is snapshotted under `.harness/plan_revisions/` and manifests record revision transitions.
