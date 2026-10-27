# Claude prompts fail for 30 s after a bridge dies holding the preference lock

Checked against `main` at `06297124` (2026-10-23).

Found while qualifying slash commands live
([0015-slash-command-qualification.md](../cli-and-slash-commands/0015-slash-command-qualification.md)).
When a Claude bridge process is killed while it holds a session's preference
file lock, the restarted bridge refuses that session's prompts with HTTP 500
for up to 30 s. The backend reads the 500 as an ambiguous dispatch, so the
user's message is parked as "outcome unknown" and a Retry inside that window
fails the same way.

## Current state

- `withPreferenceFileLock` (`bridges/claude-bridge/src/services/session-preferences.ts`)
  waits at most `PREFERENCE_LOCK_TIMEOUT_MS` (5 s) for `<prefs>.lock`, then
  throws "Timed out waiting for session preference lock".
- A lock counts as stale only when its mtime is older than
  `PREFERENCE_LOCK_STALE_MS` (30 s) **and** its owner pid is not alive
  (`snapshotIsRecoverable`). The owner refreshes the mtime every 5 s.
- Observed 2026-10-23, disposable profile `qa-slash-0015`, host worktree:
  `slash-command-inactive.spec.ts` sent a Claude command and restarted the
  bridge 0.3 s later (`stop_local_claude_server_cmd`). The killed process held
  the lock; the same-id retry 15 s later took 7.9 s and came back
  `unknown (HTTP 500)`, with the bridge logging the lock timeout. The dispatch
  stayed parked.
- Nothing is lost or run twice: the prompt never reached the CLI, and the
  parked record asks the user to retry or discard. The cost is a confusing
  "could not confirm" card and a Retry that fails until the lock ages out.
- Seen again on 2026-10-27 by `apps/backend/tests/claude-cold-dispatch-restart.test.ts`
  (todo 0223), 2 runs in 10: the test SIGKILLs a real Claude bridge right after
  a claim, and the restarted bridge's next prompt failed with this 500. A
  workflow re-sending an `absent` request after a restart hits the same window;
  it stays safe (the failed claim is rolled back, so the next pass reads
  `absent` again and retries) but is delayed until the lock ages out. The test
  now waits for the killed turn's writes to release the lock before killing.

## Outstanding work

1. Recover a lock whose owner pid is dead without waiting out the full stale
   window, while still guarding against pid reuse (for example, record the
   owner's process start time with the pid and compare both).
2. Or make the prompt route answer a definite, retryable refusal (409 with a
   retry hint) instead of a 500 while the lock is held by a dead owner, so the
   dispatch is not parked as ambiguous.
3. Add a bridge test that leaves a lock owned by a dead pid and proves a prompt
   is admitted (or refused definitely) within the 5 s wait.

## Constraints and rationale

- Never delete a lock whose owner may still be alive: two writers would race
  the preference file, which holds the durable dispatch claims that keep a
  prompt from running twice.
- A pid alone is not proof of liveness across a restart; pids are reused.

## Open questions

- Is 30 s still the right stale window once a start-time check exists?

## Needs verification

- Whether a container bridge restart (`stop_claude_server`) can leave the same
  lock; the container's preference directory survives a bridge restart.

## Related

- [0015-slash-command-qualification.md](../cli-and-slash-commands/0015-slash-command-qualification.md)
  (live restart steps; the scenario retries again after an `unknown` answer).
- [0002-session-lifecycle-consistency.md](0002-session-lifecycle-consistency.md).

## Replaces

Nothing; new on 2026-10-23.
