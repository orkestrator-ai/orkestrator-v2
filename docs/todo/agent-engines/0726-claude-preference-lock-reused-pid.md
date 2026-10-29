# A Claude preference lock whose owner pid is reused is never recovered

Checked against `main` at `863b5782` (2026-10-27). Code fixed on 2026-10-28
against `main` at `1d1f0a87`; only the live container check is left.

When a Claude bridge dies while it holds a session's `<prefs>.lock`, and the pid
recorded in that lock later belongs to any live process, the lock is never
taken over, however old it is. Every preference write for that session then
times out after 5 s, so every prompt answers 500 and is parked as "outcome
unknown", until whatever process holds that pid exits. The likeliest case is a
container restart: the lock directory is on a persistent volume and the new pid
namespace hands out small pids again, possibly to the new bridge itself. This
is the permanent form of the 30 s stall in todo 0059 (fixed with this file and
retired on 2026-10-28; the lock rule is in
[agent-engines.md](../../architecture/agent-engines.md#claude-code), "Claude Code"),
found in its task analysis (task 1, "New finding", and task 4).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Pin the wedge in failing tests**: a lock owned by this process's own pid but another instance, and a lock owned by a live pid with a different start time, must both be taken over. Status: done (2026-10-28).
2. **Recover by owner identity, not pid liveness**: record an instance id and, where readable, start time and boot id; compare them before calling a live pid the owner. Status: done (2026-10-28).
3. **Hosts without `/proc`**: decide what macOS does when the recorded pid is alive past the stale window. Status: done (2026-10-28): `ps -o lstart` on the slow path.
4. **The other pid-liveness checks in the bridge**: the change-evidence spool claim and the restart-interruption mark use the same rule. Status: done (2026-10-28).
5. **Live check in a container**: seed a lock naming a live container pid and confirm a prompt is admitted. Status: open; needs a `dev:test` container profile and a Claude credential.

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

Fixed in code on 2026-10-28, together with 0059's identity check and typed
refusal. The task analysis above records the defect as it was.

- `bridges/claude-bridge/src/services/process-identity.ts` is the one owner
  rule for the bridge. `currentProcessIdentity()` records the pid, a
  per-process `instance` id (`BRIDGE_INSTANCE_ID`, moved here from the
  turn-interruption module), on Linux the `/proc/<pid>/stat` start time
  (`procStart`) and `/proc/sys/kernel/random/boot_id` (`bootId`), and on every
  host the process start in epoch ms (`processStartedAt`, from
  `performance.timeOrigin`). `recordedOwnerState()` answers `current`, `dead`,
  `alive` or `unverified`: this process's pid under another instance (or none)
  is `dead`; a free pid is `dead`; a live pid with another boot id or
  `/proc` start time is `dead`; where `/proc` cannot answer, a `slowPath`
  caller compares `processStartedAt` with `ps -o lstart=` under `TZ=UTC`
  (2 s tolerance, cached per pid and recorded start).
- The preference lock and its recovery marker record that identity beside
  `token` (`session-preferences.ts`, `lockMetadata`). `snapshotIsRecoverable`:
  unreadable metadata after 30 s; an owner proven dead at once; an older
  bridge's lock (pid only) whose pid is dead after 30 s, or at once when it
  names this process's pid; a live owner that matches or cannot be checked,
  never. `ps` runs only once the lock is past the 30 s window.
- The wait still gives up after 5 s, now with `PreferenceLockTimeoutError`
  (`code: "preference-lock-timeout"`). `claimPromptDispatch` maps it, on the
  claim write only, to a `SessionOperationError` with code `unavailable`, and
  the prompt route answers that 503 (`sessionErrorStatus`), which the backend
  already treats as "not processed" and retryable instead of parking it as
  ambiguous.
- The turn-in-flight mark carries the same optional identity fields
  (`ClaudeTurnInFlightMark`), and `restoredTurnInterruption` reports a restart
  when `recordedOwnerState` says the writer is dead (with `ps` allowed, since
  it runs once per restored session).
- The change-evidence spool claim (`claimSpoolDirectory`, now exported with an
  injectable root and scope for tests) writes `owner.pid` as the pid on the
  first line, which older bridges still parse, and the identity as JSON on the
  second. A dead owner is replaced; a live or unverifiable one leaves the
  spool memory-only as before.
- Tests: `process-identity.test.ts` (new), the lock cases in
  `session-preferences.test.ts` (the old `:264` test now uses a spawned
  `sleep` child as the live owner; six of the new cases time out on the old
  code), two mark cases in `session-manager-turn-interruption.test.ts`, six
  claim cases in `change-evidence.test.ts`, the claim refusal in
  `session-manager-lifecycle.test.ts` and the 503 mapping in
  `routes/session.test.ts`. Live owners come from
  `process-identity-test-harness.ts`, which spawns and stops its own children.
  The `/proc` cases ran in an `oven/bun:1.4.4` container on 2026-10-28 and pass.

## Outstanding work

### Code

Nothing left. Items 1 to 5 were done on 2026-10-28: the tests (item 1), the
identity record and rule (item 2), `ps` on the macOS slow path (item 3), the
spool claim and the restart mark (item 4), and landing with 0059's identity
check and 503 refusal in the same change (item 5).

### Qualification

- In a `dev:test` profile with a container environment and a Claude
  credential: seed a lock naming a live container pid with an old mtime, send a
  prompt in that session, and confirm it is admitted within 5 s. Seed both an
  older-format lock naming the bridge's own pid (`{ "token": "x", "pid":
  <bridge pid> }`) and a new-format one naming another live container pid with
  `"procStart": "1"`. Not run: this host has no throwaway Claude credential to
  give a profile, and the user's real login must not be used.

## Assumptions and decisions

1. **What identity a lock records.**
   - Options: (a) pid, instance id, and on Linux `/proc` start time and boot
     id; (b) start time only, like `McpSourceStore`; (c) take over any lock
     far past the heartbeat whatever its pid.
   - Choice: (a), plus `processStartedAt` on every host for the `ps` check.
   - Why: the instance id alone settles the container case (the new bridge
     holding the dead one's pid) on every OS; start time catches reuse by
     another process; the boot id covers a reboot that lands on an equal start
     time. (c) would take a suspended live owner's lock and risk two writers
     on the dispatch journal.
   - Pros: one rule for all three files; additive fields, so an older bridge
     still reads the pid.
   - Cons: more fields to parse and validate; a malformed field drops only
     itself, which makes the owner less verifiable (safe) rather than more.
2. **How an older bridge's lock (pid only) is treated.**
   - Options: (a) keep its 30 s plus dead-pid rule, plus "names this process's
     pid means dead"; (b) treat every old-format lock past 30 s as
     recoverable.
   - Choice: (a).
   - Why: during an upgrade an old bridge on the same host home could still
     hold a live lock. This process never writes a lock without its instance,
     so its own pid in an old-format lock is a dead predecessor's.
   - Pros: safe with mixed versions; clears the container case, the likeliest
     one, at once.
   - Cons: an old-format lock held by an unrelated reused pid still waits
     until that process exits. It needs an old bridge to have died mid-write
     before upgrading, so it is not worth a riskier rule.
3. **How fast a proven-dead owner's lock is taken over (0059 item 1).**
   - Options: (a) at once; (b) still after the 30 s window.
   - Choice: (a) for new-format locks; old-format locks keep their rule.
   - Why: with identity recorded, "dead" is proof, not a guess, and the 30 s
     wait was the whole of 0059's stall. Unreadable metadata (a lock mid-write)
     still waits 30 s, so a lock being created is never removed.
   - Pros: the restarted bridge's first write succeeds.
   - Cons: none found; a dead pid cannot come back as the same owner.
4. **macOS and other hosts without `/proc` (task 3).**
   - Options: (a) `ps -o lstart= -p <pid>` once the lock is past the stale
     window, compared with the owner's recorded start; (b) keep the old rule.
   - Choice: (a), with `TZ=UTC LC_ALL=C` so the output parses without local
     time or daylight-saving ambiguity, a 2 s tolerance, a 1 s spawn timeout,
     and verdicts cached per pid and recorded start (an unanswered `ps` is
     retried after a minute).
   - Why: closes the wedge on macOS, where pids wrap soonest, at no cost on
     the normal write path. A healthy owner refreshes its mtime every 5 s, so
     only a dead or suspended owner reaches the slow path.
   - Pros: parity with Linux for the permanent wedge; a cached verdict cannot
     go wrong in the unsafe direction (a pid that stopped matching never
     matches again, and liveness is checked first).
   - Cons: a reused pid started within 2 s of the dead owner looks like the
     owner (the lock then stays held, the old behaviour); `spawnSync` blocks
     the event loop for one `ps` per stale lock. The owner's start comes from
     `performance.timeOrigin`, which on this host matched `lstart` to the
     second in three runs.
5. **The restart mark and the spool claim (task 4).**
   - Options: (a) one shared helper at all three sites; (b) fix only the lock.
   - Choice: (a). Both sites call `recordedOwnerState` with `slowPath: true`,
     since each runs once per restored session or once per process.
   - Why: the same reasoning bug would otherwise survive in two places.
   - Pros: one rule; the spool claim now also takes over a claim left by this
     process's pid under another instance (before, it reused it silently,
     which had the same effect but left the old owner's line).
   - Cons: `owner.pid` changes format (pid line plus JSON line); older
     bridges read only the first line, which is exactly the pid they wrote.
6. **The typed refusal (0059 item 2).**
   - Options: (a) 503 with a fixed reason, on the claim write only; (b) 409
     with a retry hint; (c) leave the 500.
   - Choice: (a). New `SessionOperationCode` `unavailable`, mapped to 503 by
     `sessionErrorStatus`; the reason names no session data.
   - Why: the backend already maps 503 to a retryable "not processed"
     refusal, while 409 means "running" or "conflict" on this route. Only the
     claim write maps the timeout: it fails before anything reaches the
     journal or the CLI, so the prompt provably did not run. Every other
     caller still sees a plain failure.
   - Pros: no backend change; a Retry works once the lock frees.
   - Cons: the card shows the generic "unavailable" notice with the bridge's
     reason, not a lock-specific message.
7. **One change with 0059, or two.**
   - Options: (a) land with 0059's identity check and refusal; (b) this file
     first.
   - Choice: (a), as the analysis recommended. 0059's items are ticked in
     its file and its index row is Finished: Yes; the file is kept until a
     maintainer retires it, since four other documents link to it.
   - Pros: the lock format changes once.
   - Cons: a larger review.
8. **Test-only seams.**
   - Options: (a) spawned `sleep` children as live owners and a
     `setPreferenceLockTimeoutForTesting` hook to make a wait fail fast; (b)
     an injected liveness function.
   - Choice: (a), as recommended. Linux-only cases skip without `/proc`, and
     the `ps` cases skip without `ps`.
   - Why: tests the real `/proc` and `process.kill` paths, signals only the
     test's own children, and keeps the suite deterministic: no case waits
     out the real 5 s.
   - Pros: real behaviour; fast.
   - Cons: a child per case, stopped in `afterEach`; one test-only export.

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

- ~~Should a session wedged by an old-format lock be cleared once by a startup
  sweep?~~ Answered 2026-10-28: no sweep. The fixed bridge takes over an
  old-format lock naming its own pid on the first write that meets it, which
  is the only time the wedge shows, and a sweep would touch every session's
  lock at start.

## Needs verification

- Whether a container restart in practice gives a long-lived process (or the new
  bridge) the dead bridge's pid. Task 5 stages the effect without needing it.
- The container qualification above (task 5): not run.
- The macOS `ps` path against a real reused pid: the tests prove it against a
  live child given a wrong recorded start, not an actual wrap-around.

## Related

- [agent-engines.md](../../architecture/agent-engines.md#claude-code) ("Claude Code"): the preference lock
  rule, moved there when todo 0059 (the 30 s stall, fixed in the same change)
  was retired on 2026-10-28.
- [0002-session-lifecycle-consistency.md](0002-session-lifecycle-consistency.md).
- [container-lifecycle.md](../../architecture/container-lifecycle.md)
  (provider-state volumes).

## Replaces

Nothing; new on 2026-10-27, split from todo
0059's task analysis (retired on 2026-10-28).
