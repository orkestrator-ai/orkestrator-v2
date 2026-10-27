# A Claude preference lock whose owner pid is reused is never recovered

Checked against `main` at `863b5782` (2026-10-27).

When a Claude bridge dies while it holds a session's `<prefs>.lock`, and the pid
recorded in that lock later belongs to any live process, the lock is never
taken over, however old it is. Every preference write for that session then
times out after 5 s, so every prompt answers 500 and is parked as "outcome
unknown", until whatever process holds that pid exits. The likeliest case is a
container restart: the lock directory is on a persistent volume and the new pid
namespace hands out small pids again, possibly to the new bridge itself. This
is the permanent form of the 30 s stall in
[0059-claude-preference-lock-after-restart.md](0059-claude-preference-lock-after-restart.md),
found in its task analysis (task 1, "New finding", and task 4).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Pin the wedge in failing tests**: a lock owned by this process's own pid but another instance, and a lock owned by a live pid with a different start time, must both be taken over. Status: open.
2. **Recover by owner identity, not pid liveness**: record an instance id and, where readable, start time and boot id; compare them before calling a live pid the owner. Status: open.
3. **Hosts without `/proc`**: decide what macOS does when the recorded pid is alive past the stale window. Status: open.
4. **The other pid-liveness checks in the bridge**: the change-evidence spool claim and the restart-interruption mark use the same rule. Status: open.
5. **Live check in a container**: seed a lock naming a live container pid and confirm a prompt is admitted. Status: open (depends on 2).

### 1. Pin the wedge in failing tests

**Problem.** The suite currently asserts the wedge as correct behaviour.

**Context.** Tests must signal only processes they spawned (AGENTS.md,
"Production Orkestrator shares this host"). `process.kill(pid, 0)` sends no
signal, but the test should still name a pid it owns.

**Investigation.** `bridges/claude-bridge/src/services/session-preferences.test.ts:264`
("does not steal an old lock whose owner process is still alive") writes a lock
with `pid: process.pid`, back-dates it 60 s, and expects the write to keep
waiting. That is exactly the self-pid case after a container restart: the
recorded pid is this process, but the writer was a different, dead process. The
file passes today (19 tests, run 2026-10-27 with
`bun test src/services/session-preferences.test.ts` in the bridge directory).
No test covers a live pid whose start time differs.

**Decisions.**

- **How is a "live, unrelated owner" modelled once the self-pid case means "dead"?**
  - **Spawn a short-lived child (`sleep`) in the test, record its pid in the lock, and stop it through its handle afterwards (recommended).**
    - Pros: a real live pid the test owns; follows the signalling rule; reusable for the start-time case.
    - Cons: a child process per test; needs cleanup in `afterEach`.
  - **Inject a liveness function into the lock module.**
    - Pros: no processes; fully deterministic.
    - Cons: tests the seam rather than `/proc` and `process.kill`; a new test-only export.

### 2. Recover by owner identity, not pid liveness

**Problem.** `snapshotIsRecoverable` treats "pid is alive" as "owner is alive".

**Context.** The preference file holds the durable dispatch claims
(`dispatchedRequestIds`) that stop a prompt running twice, so a lock whose owner
may still be alive must never be removed (0059, "Constraints and rationale").
`McpSourceStore` already proves identity by start time
(`readProcStart`, `apps/backend/src/core/mcp-management/source-store.ts:85-94`;
takeover rule at `:427-438`). The bridge already has a per-process instance id
for the restart mark (`BRIDGE_INSTANCE_ID`,
`bridges/claude-bridge/src/services/session-manager-turn-interruption.ts:27`).

**Investigation.** Confirmed by reading the code; not reproduced live.
- The lock records only `{ token, pid }`
  (`bridges/claude-bridge/src/services/session-preferences.ts:194-197`, written at
  `:345-350`).
- `processIsAlive` returns true when `process.kill(pid, 0)` succeeds or fails
  with `EPERM` (`:243-250`), so a pid now held by another user's process also
  counts as alive.
- `snapshotIsRecoverable` (`:252-257`) needs the mtime to be older than 30 s
  **and** the pid to be dead. With a live pid it is false at any age, so
  `recoverStaleLock` (`:266`) never removes the lock, and
  `withPreferenceFileLock` (`:337-388`) throws "Timed out waiting for session
  preference lock" after 5 s (`:363`) on every attempt.
- The throw reaches `app.onError`, which answers 500
  (`bridges/claude-bridge/src/index.ts:41-45`); the backend parks 500 as
  `AmbiguousPromptDispatchError` (`apps/backend/src/core/http-bridge-provider.ts:375-379`).
  The prompt never reaches the CLI: the claim write in `claimPromptDispatch`
  (`session-manager-lifecycle.ts:383`) fails before anything is written. So
  nothing runs twice and nothing is lost; the session is simply unusable.
- Every caller of `updateSessionPreferences` (`:597`) and
  `deleteSessionPreferences` (`:656`) for that session id takes the same lock:
  plan-mode and settings changes fail too. Other sessions are unaffected.
- Where it happens. `claudeSessionPreferencesDir()` is
  `~/.claude/orkestrator/session-preferences`
  (`bridges/claude-bridge/src/services/claude-home.ts:59-61`). In a container,
  `/home/node/.claude/orkestrator` is a provider-state volume
  (`apps/backend/src/core/container-state-layout.ts:67-68`), so the lock
  survives a container restart and rebuild. The bridge is started with `setsid`
  from `docker exec` (`apps/backend/src/core/commands-containers.ts:950`), so
  after a restart its pid is a small number in a fresh namespace, and the dead
  bridge's pid may be live again, possibly as the new bridge. On a host the
  same follows a reboot (`~/.claude` is the real home) or pid wrap-around
  (macOS wraps at 99999) before the session's next write.
- The bug needs the bridge to die during a lock hold, which lasts only for one
  read and atomic write, so it is rare per restart. 0059 observed that window
  being hit by a restart 0.3 s after a prompt.
- Certainty: high that a reused live pid wedges the lock indefinitely; the
  container pid-reuse path is plausible but not demonstrated.

**Decisions.**

- **What identity does a lock record?**
  - **`pid`, a per-process `instance` id, and on Linux the `/proc/<pid>/stat` start time plus `/proc/sys/kernel/random/boot_id` (recommended).**
    - Pros: `pid === process.pid` with a foreign `instance` proves the old owner is dead on every OS; start time catches reuse by another process; boot id closes the reboot-plus-equal-start-time case 0059 task 4 names; one rule for preference locks and recovery markers.
    - Cons: more fields to parse; an old lock without them must still be handled (next decision).
  - **Start time only, as 0059 item 1 proposes.**
    - Pros: one new field; same as the backend precedent.
    - Cons: no answer where `/proc` is missing; a reboot can reproduce an equal start time.
  - **Take over any lock whose mtime is far beyond the heartbeat (for example 10 minutes), whatever the pid.**
    - Pros: bounds the wedge everywhere with no identity code.
    - Cons: a suspended live owner (stopped process, a slow host) loses its lock, which risks two writers on the dispatch journal; contradicts the file's constraint.
- **How is a lock written by an older bridge (no `instance`, no start time) treated?**
  - **Keep today's rule for it: recoverable when the pid is dead and the mtime is past 30 s, plus "pid is this process" means dead, because this process never writes a lock without `instance` (recommended).**
    - Pros: safe during an upgrade, when an old and a new bridge can briefly share a host home directory; the self-pid shortcut still clears the container case.
    - Cons: an old-format lock held by an unrelated reused pid stays wedged until that process exits.
  - **Treat every old-format lock past 30 s as recoverable.**
    - Pros: clears every legacy wedge.
    - Cons: an old bridge still running on the same host home (another environment) could lose a live lock.
- **Does this ship with 0059 item 1 or separately?**
  - **One change that closes 0059 tasks 1, 2 and 4 and this file together (recommended).** The identity check that removes the 30 s wait is the same check that removes the wedge, and 0059's typed 503 refusal turns the remaining timeouts into retryable refusals.
    - Pros: one lock format change, one review, one set of tests; the format changes once.
    - Cons: a larger change; the 503 refusal does not by itself unwedge anything, so it must not be shipped as the fix for this file alone.
  - **This file first, 0059 later.**
    - Pros: smallest step for the permanent case.
    - Cons: the lock format would change twice if 0059 then adds start time differently.

### 3. Hosts without `/proc`

**Problem.** On macOS there is no `/proc`, and 0059's recommendation keeps
today's rule there. For this defect that leaves a permanent wedge when a host
bridge's pid is reused by an unrelated process.

**Context.** Host bridges on one machine share `~/.claude`, so a lock can be
genuinely held by another live bridge; the self-pid shortcut does not cover
that.

**Investigation.** 0059 rejected `ps -o lstart=` because it spawns a process on
a hot write path. It need not be hot: identity is only needed after the lock
has been seen held past the 30 s stale window with a live pid, which is the rare
path.

**Decisions.**

- **What does macOS do when the recorded pid is alive past the stale window?**
  - **Run `ps -o lstart= -p <pid>` once per lock inode on that slow path, and compare it with a start time the owner recorded at lock creation (recommended).**
    - Pros: closes the wedge on every host; no cost on the normal write path; cached per inode so the 10 ms wait loop does not spawn repeatedly.
    - Cons: `lstart` has one-second precision, so a reused pid started in the same second as the dead owner is not detected; a spawn and a parser to test.
  - **Keep today's rule on macOS, as 0059 recommends.**
    - Pros: no new code path on macOS.
    - Cons: the wedge stays possible on macOS hosts, where pid wrap-around comes sooner than on Linux.

### 4. The other pid-liveness checks in the bridge

**Problem.** Two other bridge sites trust a live pid the same way.

**Context.** Not part of the lock, but the same reuse reasoning applies.

**Investigation.**
- `claimSpoolDirectory` (`bridges/claude-bridge/src/services/change-evidence.ts:329-356`)
  treats a live `owner.pid` holder as another bridge and returns `undefined`,
  leaving the change-evidence spool memory-only for this process's lifetime.
  It already treats its own pid as its own (`:347`). A reused pid owned by
  another process would make shell change evidence non-durable, not wedge
  prompts.
- `restoredTurnInterruption`
  (`bridges/claude-bridge/src/services/session-manager-turn-interruption.ts:166-171`)
  reports `idle` when the mark's pid is not this process and is alive. A reused
  pid would hide the "restarted mid-turn" notice for that turn.

**Decisions.**

- **Are these fixed here?**
  - **Yes: move the identity check into one shared helper and use it at all three sites (recommended).**
    - Pros: one rule; the same reuse bug cannot survive in a sibling; the spool and the mark already carry a pid and can carry the same identity.
    - Cons: widens the change into two more files and their tests.
  - **Fix only the preference lock and note the others.**
    - Pros: smallest change for the severe case.
    - Cons: the same reasoning bug stays in two places, with milder symptoms that are harder to notice.

### 5. Live check in a container

**Problem.** The container pid-reuse path has not been seen live.

**Context.** Killing a bridge inside its brief lock hold is timing-dependent,
which is why 0059 did not stage it.

**Investigation.** The wedge can be staged deterministically: write a lock file
naming a pid that is live inside the container (for example the bridge's own,
read from inside the container) with an old mtime, then send a prompt.

**Decisions.**

- **How is it run?**
  - **In a `dev:test` profile with a container environment, seed the lock as above, send a prompt, and confirm it is admitted on the fixed build and parked on `main` (recommended).**
    - Pros: deterministic; exercises the real volume, namespace and backend mapping.
    - Cons: needs a container profile and a Claude credential.
  - **Restart a container mid-turn until the lock is left behind.**
    - Pros: the real failure.
    - Cons: may need many attempts; adds little over the seeded lock.

## Current state

- The lock records `{ token, pid }` and nothing else
  (`bridges/claude-bridge/src/services/session-preferences.ts:194-197`).
- A lock is recoverable only when its mtime is past 30 s and its pid is not
  alive (`snapshotIsRecoverable`, `:252-257`); `EPERM` counts as alive
  (`processIsAlive`, `:243-250`).
- A lock wait gives up after 5 s with a plain `Error` (`:363`), answered as 500
  and parked by the backend as an ambiguous dispatch.
- The test at `session-preferences.test.ts:264` asserts that a lock naming
  `process.pid` is never taken over.
- The container lock directory is a provider-state volume
  (`apps/backend/src/core/container-state-layout.ts:67-68`).
- The same "live pid means live owner" rule is used in
  `change-evidence.ts:347-348` and `session-manager-turn-interruption.ts:171`.

## Outstanding work

### Code

1. Rewrite the `:264` test to use a spawned child as the live owner, and add
   failing tests: a lock naming `process.pid` with a foreign instance is taken
   over at once; on Linux, a lock naming a live child with a wrong start time is
   taken over; a lock naming a live child with its real identity is never taken
   over.
2. Record `instance`, and on Linux start time and boot id, in the lock and the
   recovery marker; recover when the pid is dead, or is this process under
   another instance, or its identity differs. Keep the 30 s rule for old-format
   locks and unverifiable owners.
3. Decide and implement the macOS slow-path check (task 3).
4. Apply the shared identity check to `claimSpoolDirectory` and
   `restoredTurnInterruption`, with tests.
5. Land together with 0059's identity check and typed 503 refusal, or rebase
   0059 onto this lock format.

### Qualification

- In a `dev:test` profile with a container environment and a Claude
  credential: seed a lock naming a live container pid with an old mtime, send a
  prompt in that session, and confirm it is admitted within 5 s.

## Constraints and rationale

- Never remove a lock whose owner may still be alive: two writers would race the
  dispatch claims that stop a prompt running twice.
- A pid alone is not identity. It is reused across container restarts, reboots
  and wrap-around.
- Filed separately from 0059 because the README forbids new items in an
  existing file, and because this defect is permanent rather than 30 s, needs
  its own tests (including rewriting one that pins the wedge), and reaches two
  other bridge sites 0059 does not cover.
- Tests signal only processes they spawned and record the pid at spawn time.

## Open questions

- Should a session wedged by an old-format lock on an existing install be
  cleared once by a startup sweep that removes locks naming this process's own
  pid? It would clear the container case on first start of the fixed bridge.

## Needs verification

- Whether a container restart in practice gives a long-lived process (or the new
  bridge) the dead bridge's pid. Task 5 stages the effect without needing it.

## Related

- [0059-claude-preference-lock-after-restart.md](0059-claude-preference-lock-after-restart.md)
  (the 30 s stall; its item 1 start-time check is the same mechanism).
- [0002-session-lifecycle-consistency.md](0002-session-lifecycle-consistency.md).
- [container-lifecycle.md](../../architecture/container-lifecycle.md)
  (provider-state volumes).

## Replaces

Nothing; new on 2026-10-27, split from
[0059-claude-preference-lock-after-restart.md](0059-claude-preference-lock-after-restart.md)'s
task analysis.
