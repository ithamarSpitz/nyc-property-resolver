# Agent Provider Quota and Capacity Policy

The harness does not enable paid on-demand billing. Provider switching is based on explicit execution evidence rather than a scraped UI percentage.

## Provider priority

For a new run, implementation/review/planning prefer Codex when the Codex CLI is installed and authenticated with ChatGPT. Cursor remains the additive fallback.

```text
Codex implementation ladder
  Sol Medium
  Sol Medium
  Sol High
  Astra Medium
```

A substantive failure advances this ladder. A substantive Astra failure blocks for human inspection / plan repair; Cursor is not used as a quality escalation after Astra.

Cursor's existing ladder remains unchanged and is entered automatically only when Codex becomes unavailable for the run (for example explicit Codex usage exhaustion, authentication loss, model unavailability, or adapter failure):

```text
Cursor implementation ladder
  Composer 2.5
  Composer 2.5
  Grok 4.6 High
  Opus Thinking High
```

A provider switch happens inside the current scheduler attempt and does not consume a separate implementation attempt.

## Codex usage exhaustion

The harness does not parse the interactive `/status` display. There is no dependency on a brittle remaining-usage screen parser.

An actual Codex invocation that returns an explicit usage-limit error is classified as quota exhaustion. When the message identifies the window, usage records distinguish the 5-hour and weekly windows; otherwise the scope is recorded as `unspecified` rather than guessed.

```text
Codex reports explicit usage exhaustion
  -> preserve task worktree/state/logs
  -> mark Codex disabled for the current run
  -> record provider switch
  -> invoke Cursor in the same scheduler attempt
```

A future new run clears the run-local Codex-disabled marker and probes Codex again.

## Provider capacity and transient failures

Capacity/transient infrastructure failures are not substantive model failures and do not advance the model ladder or switch provider immediately. Examples include provider saturation, network/transport failure, CLI timeout, or a stalled invocation.

```text
capacity / network / timeout / transient CLI failure
  -> WAITING_FOR_CAPACITY
  -> preserve task worktree/state/logs
  -> do not consume provider/model retry budget
  -> retry the same provider/model after capacity.retry_interval_minutes
```

If the failure occurs during review, resume returns to verification/review and does not rerun an already successful implementation.

## Cursor quota

Cursor's existing explicit included-usage handling remains available if the run has already fallen back to Cursor:

```text
Cursor reports included-usage exhaustion
  -> WAITING_FOR_QUOTA
  -> preserve worktree/state/logs
  -> do not consume retry budget
  -> wait or exit according to quota.policy
```

`quota.policy=wait` keeps the harness process alive. If `reset_at` is known it waits until the reset plus grace; otherwise it uses `quota.probe_interval_minutes`. `quota.policy=stop` persists the same state and exits for a later `resume`.

Useful commands:

```bash
python harness.py quota status
python harness.py quota set-reset <ISO-8601>
python harness.py quota clear-reset
python harness.py usage
```

`usage` reports Codex and Cursor separately, including model calls, failures, quota/capacity/transient events, and provider switches. Codex token counts are recorded when present in the CLI JSON event stream; Cursor token counts are not invented when the CLI does not expose them.
