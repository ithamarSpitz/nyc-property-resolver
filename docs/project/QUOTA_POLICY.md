# Cursor Included-Usage Policy

The harness does not use on-demand billing.

Cursor does not provide the harness with a supported exact "percent remaining" CLI contract, so the harness reacts to actual configured quota-exhaustion output instead of pretending to enforce a 10% threshold.

## State transition

```text
agent reports included-usage exhaustion
  -> WAITING_FOR_QUOTA
  -> persist worktree/state/logs
  -> do not consume retry budget
  -> optionally tear down task Docker environment
  -> wait or exit according to quota.policy
  -> resume same task/stage when quota is available
```

If quota is exhausted during review, the already-written implementation is preserved and resume starts from verification/review, not from a fresh coding-agent call.

## Waiting

`quota.policy=wait` keeps the harness process alive. If `reset_at` is known, it sleeps until reset plus a small grace period. Otherwise it retries at `probe_interval_minutes`. Windows keep-awake is temporary and active only while waiting.

`quota.policy=stop` persists exactly the same state but exits; `python harness.py resume <sprint>` continues later.

Useful commands:

```bash
python harness.py quota status
python harness.py quota set-reset <ISO-8601>
python harness.py quota clear-reset
```

## Provider capacity is separate from quota

`resource_exhausted` by itself is treated as transient provider capacity rather than evidence that the account's included usage is exhausted. The state transition is:

```text
provider reports transient capacity exhaustion
  -> WAITING_FOR_CAPACITY
  -> persist worktree/state/logs
  -> do not consume retry budget
  -> retry after capacity.retry_interval_minutes
```

Explicit quota phrases (for example `quota exceeded` or `monthly usage limit`) take precedence over the generic capacity signal. If capacity is exhausted during review, resume repeats verification/review and does not rerun an already successful implementation.
