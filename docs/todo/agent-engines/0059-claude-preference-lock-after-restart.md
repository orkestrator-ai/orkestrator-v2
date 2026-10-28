# Claude prompts fail for 30 s after a bridge dies holding the preference lock

Checked against `main` at `06297124` (2026-10-23). Every item done on
2026-10-28 (against `main` at `1d1f0a87`), in the same change as
[0726](0726-claude-preference-lock-reused-pid.md), which records the decisions.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Recover or refuse definitely**: items 1 and 2 together: take over a dead owner's lock at once (pid plus start time), or answer a definite retryable refusal instead of 500. Status: done (2026-10-28): both.
2. **Regression test**: item 3, a bridge test with a lock owned by a dead pid that proves admission (or a definite refusal) inside the 5 s wait. Status: done (2026-10-28).
3. **Stale window**: the open question, whether 30 s is still right once identity is checked. Status: done (2026-10-28): kept as the fallback.
4. **Container restart**: the "Needs verification" item, whether a container bridge restart leaves the same lock. Status: done: answered by the code reading below and closed by 0726's identity check.

### 1. Recover or refuse definitely

**Problem.** A Claude bridge killed while it holds `<prefs>.lock` makes the restarted bridge time out on that session's preference writes for up to 30 s. The prompt route answers 500, the backend parks the message as "outcome unknown", and a Retry in that window fails the same way.

**Context.** The preference file holds the durable dispatch claims (`dispatchedRequestIds`) that stop a prompt running twice, so two writers must never race it. The file names two alternatives; they are not exclusive.

**Investigation.** Unchanged since `06297124` (last touch `71abfcfb`, unrelated).
- The constants are at `bridges/claude-bridge/src/services/session-preferences.ts:189-191`. The lock records only `{ token, pid }` (`:194-197`).
- `snapshotIsRecoverable` (`:252-257`) needs the mtime to be older than 30 s **and** the pid to be dead. The wait loop gives up after 5 s (`:337-366`), so a lock that is not yet stale always times out.
- The timeout is a plain `Error` (`:363`). It falls through to the bridge's `app.onError`, which answers 500 (`bridges/claude-bridge/src/index.ts:41-45`). The backend maps 500 and 502 to `AmbiguousPromptDispatchError` (`apps/backend/src/core/http-bridge-provider.ts:375-379`), and maps 404, 409 and transient statuses (503 included) to a retryable refusal (`:383-389`).
- A refusal is safe here. `claimPromptDispatch` (`bridges/claude-bridge/src/services/session-manager-lifecycle.ts:325-440`) writes the claim through `updateSessionPreferences` before anything reaches the CLI (`:383-385`). The lock timeout throws before `writePreferencesFile`, so nothing is on disk and the in-memory claim is rolled back (`:430-437`). The prompt definitely did not run.
- There is a precedent for the identity check. `McpSourceStore` reads field 22 of `/proc/<pid>/stat` (`readProcStart`, `apps/backend/src/core/mcp-management/source-store.ts:85-94`). It takes over a dead holder's lock at once, takes over a live pid whose start time differs, and never takes over an unverifiable live holder on age alone (`:427-438`).
- New finding: a reused pid is not just slow, it is permanent. With the current rule, a lock whose recorded pid now belongs to any live process, including the restarted bridge itself, is never recoverable, whatever its age.

**Decisions.**

- **Which fix ships?**
  - **Both: record and compare the start time, and map a lock timeout on the claim write to a definite refusal (recommended).** Identity-based takeover removes the 30 s wait. The typed refusal covers a lock held by a live, slow owner.
    - Pros: fixes the observed case and the permanent pid-reuse wedge. A Retry works at once. A typed error keeps a timeout on a later write (after the CLI started) from being mislabelled.
    - Cons: two changes to review. The refusal must be scoped to the claim path only, since a timeout on a post-dispatch write is genuinely not "not processed".
  - **Start-time takeover only.**
    - Pros: one change; the common case recovers at once.
    - Cons: a lock held by a suspended or slow live owner still produces 500 and an ambiguous park.
  - **Definite refusal only (409 or 503).**
    - Pros: smallest change; no `/proc` dependency.
    - Cons: the user still waits up to 30 s, and the pid-reuse wedge stays unbounded.
- **What does the refusal answer?**
  - **503 with a fixed, content-free reason (recommended).** It is already in the backend's "not processed" set.
    - Pros: no backend change; matches "unavailable, try again".
    - Cons: the card shows a generic unavailable notice unless the reason is surfaced.
  - **409 with a retry hint.**
    - Pros: matches the file's wording; 409 is also mapped as retryable.
    - Cons: 409 already means "running" or "conflict" on this route, so the user sees the wrong kind of message.
- **What happens when identity cannot be read (no `/proc`, as on macOS)?**
  - **Keep today's rule there: pid dead, or mtime past the stale window (recommended).**
    - Pros: macOS keeps working exactly as now; Linux hosts and containers get the fast path.
    - Cons: macOS keeps the 30 s wait and the pid-reuse risk.
  - **Use `ps -o lstart=` on macOS.**
    - Pros: parity across hosts.
    - Cons: spawns a process on a hot write path; harder to test.

### 2. Regression test

**Problem.** No test shows that a lock left by a dead owner admits a prompt within the 5 s wait.

**Context.** `bridges/claude-bridge/src/services/session-preferences.test.ts` already covers waiting for a live holder (`:246`), not stealing an old lock whose owner is alive (`:264`), and recovering an abandoned recovery marker owned by a dead pid (`:285`). The last one back-dates both files by 60 s, so the fresh-lock case is untested.

**Investigation.** The fresh-lock case (mtime now, dead pid) is the observed failure. A pid-reuse case (lock records `process.pid` with a different start time) would also pin the new finding.

**Decisions.**

- **At which level is it tested?**
  - **Unit tests in `session-preferences.test.ts`, plus one route test for the refusal status (recommended).**
    - Pros: fast and deterministic; they reuse the existing fixtures.
    - Cons: the restart itself is not exercised.
  - **A process-level test that kills a real bridge mid-write.**
    - Pros: proves the observed scenario end to end.
    - Cons: timing-dependent and slow; the live restart step in 0015 already covers it.

### 3. Stale window

**Problem.** The 30 s window was chosen when the pid alone guarded liveness.

**Context.** The heartbeat refreshes the mtime every 5 s (`session-preferences.ts:369-371`), so a live owner's lock never ages past about 5 s.

**Investigation.** With an identity check the window only matters where identity cannot be read, and for a live owner that has stopped heart-beating (suspended).

**Decisions.**

- **What happens to the 30 s window?**
  - **Keep 30 s as the fallback where identity is unverifiable (recommended).**
    - Pros: no change in behaviour where nothing new is known; low risk.
    - Cons: macOS keeps the wait.
  - **Lower it to about 15 s (three heartbeats).**
    - Pros: faster recovery everywhere.
    - Cons: a briefly suspended live owner could lose its lock, risking two writers on the dispatch journal.

### 4. Container restart

**Problem.** It was unknown whether a container bridge restart can leave the same lock.

**Context.** `stop_claude_server` is registered at `apps/backend/src/core/commands-registry-servers.ts:249`, `stop_local_claude_server_cmd` at `apps/backend/src/core/commands-registry-pr.ts:458`.

**Investigation.** Yes, and a full container restart is worse. `claudeSessionPreferencesDir()` is `~/.claude/orkestrator/session-preferences` (`bridges/claude-bridge/src/services/claude-home.ts:59-61`). `/home/node/.claude/orkestrator` is a provider-state volume (`apps/backend/src/core/container-state-layout.ts`, the third `claude` entry), so the lock survives restarts and rebuilds. A bridge restart inside a running container keeps the pid namespace, so it behaves like the host case. A container restart starts a new pid namespace with small sequential pids, so the dead bridge's pid is likely to be live again, possibly as the new bridge. Today that lock is never recovered. On the host the same applies after a reboot (`~/.claude` is the real home).

**Decisions.**

- **How is this closed?**
  - **Treat it as answered by code reading and cover it with the item-1 start-time check, which is relative to the host boot (recommended).**
    - Pros: no live run needed; the fix closes it.
    - Cons: a host reboot also resets start times, so a reboot plus pid reuse plus an equal start time stays theoretically possible; adding the boot id (`/proc/sys/kernel/random/boot_id`) to the lock closes it fully.
  - **Run a live Docker restart to confirm first.**
    - Pros: direct evidence.
    - Cons: needs a timed kill mid-write; adds little over the code reading.

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

Nothing left. Done on 2026-10-28 with
[0726](0726-claude-preference-lock-reused-pid.md):

1. ~~Recover a lock whose owner pid is dead without waiting out the full stale
   window, while still guarding against pid reuse.~~ A lock now records the
   owner's instance id, and on Linux its `/proc` start time and boot id
   (`process-identity.ts`). An owner proven dead (free pid, this process's pid
   under another instance, or another start or boot) is taken over at once; an
   older bridge's pid-only lock keeps the 30 s rule.
2. ~~Make the prompt route answer a definite, retryable refusal instead of a
   500.~~ A lock wait that times out on the claim write is a 503 with a fixed
   reason (`unavailable`), not 409, which already means "running" on this
   route; the backend retries 503 as "not processed".
3. ~~Add a bridge test that leaves a lock owned by a dead pid and proves a
   prompt is admitted (or refused definitely) within the 5 s wait.~~
   `session-preferences.test.ts` ("takes over at once a fresh lock whose owner
   pid is gone") and `session-manager-lifecycle.test.ts` ("refuses definitely
   when a live owner keeps the preference lock through the claim").

## Constraints and rationale

- Never delete a lock whose owner may still be alive: two writers would race
  the preference file, which holds the durable dispatch claims that keep a
  prompt from running twice.
- A pid alone is not proof of liveness across a restart; pids are reused.

## Open questions

- ~~Is 30 s still the right stale window once a start-time check exists?~~
  Kept (2026-10-28): it now applies only where identity cannot prove the
  owner dead (unreadable metadata, an older bridge's lock) and as the point
  where macOS asks `ps`.

## Needs verification

- ~~Whether a container bridge restart (`stop_claude_server`) can leave the
  same lock.~~ Yes, by code reading (task 4); the identity check covers it.
  The live container check is 0726's qualification item.

## Related

- [0015-slash-command-qualification.md](../cli-and-slash-commands/0015-slash-command-qualification.md)
  (live restart steps; the scenario retries again after an `unknown` answer).
- [0002-session-lifecycle-consistency.md](0002-session-lifecycle-consistency.md).
- [0726-claude-preference-lock-reused-pid.md](0726-claude-preference-lock-reused-pid.md):
  the permanent wedge when the recorded owner pid is reused, split from task 1.

## Replaces

Nothing; new on 2026-10-23.
