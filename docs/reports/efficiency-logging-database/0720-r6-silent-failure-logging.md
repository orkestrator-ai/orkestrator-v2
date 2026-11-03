# Log the failures that are still silent

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Writer lease loss**: log it and tell the user schedules have paused. Status: open.
2. **Local bridge exit**: log code and signal. Status: open.
3. **Pi and Cursor resume fallback**: log it and surface it. Status: open.
4. **ACP exits and 500s, Cursor and Pi turn failures**: log them at `warn` with bounded fields. Status: open.
5. **Storage swallows**: SQLite lease heartbeat and WAL scrub failures. Status: open.

### 1. Writer lease loss

**Problem.** Losing the registry writer lease stops every schedule with no line anywhere.

**Context.** The lease also gates container mutations, which fail visibly with `RegistryWriterLeaseBusyError`. Schedules just stop: `ScheduledJobService` returns early when `isWriter` is false (`scheduled-jobs/service.ts:208`, `:246`, wired at `core/index.ts:2734`).

**Investigation.** `registry-writer-lease.ts` has no logger. `refresh` sets `lost` and stops the heartbeat when the token differs; `isHeld` does the same on a missing or malformed file. A second backend that never held the lease is a normal state and also reads as not held (`core/index.ts:1903-1914`).

**Decisions.**

- **What to log?**
  - **One `warn` on the held-to-lost transition, and one `info` for a backend that starts without it (recommended).**
    - Pros: each is a single line per change, not per check; the second backend case stays distinct.
    - Cons: a new area or event, and the lease module gains a logger.
  - **Warn on every failed `isHeld`.**
    - Pros: no state to keep.
    - Cons: floods: `isHeld` runs from every scheduled tick.
- **How does a user learn?**
  - **A status field in the scheduled jobs answer and a notice in Settings → Schedules (recommended).**
    - Pros: only people using schedules see it, which is where it matters.
    - Cons: an additive field older clients ignore, so they stay silent.
  - **A global toast.**
    - Pros: unmissable.
    - Cons: noise for a user with no schedules who has two backends on one directory.

### 2. Local bridge exit

**Problem.** An agent vanishes mid-turn with no code or signal in any log.

**Context.** Startup exits are already reported through an error (`commands-servers.ts:345-346`). Only the running phase is silent.

**Investigation.** `commands-servers.ts:1301` is `child.once("exit", () => { ... })`, which takes no arguments and writes nothing. The `local-server` vocabulary has no exit event (`log-vocabulary/local-server.ts`). `app-server.exited` shows the Codex bridge doing this for its own child.

**Decisions.**

- **Which exits are logged?**
  - **All, at `warn` unless the backend asked for the stop, then `info` (recommended).**
    - Pros: `server.stopping` already records the intent, so the two read together; an unexpected death stands out.
    - Cons: needs the stop intent checked in the handler.
  - **Only non-zero codes and signals.**
    - Pros: fewer lines.
    - Cons: a bridge that exits 0 unexpectedly stays silent, which is the harder case.

### 3. Pi and Cursor resume fallback

**Problem.** A failed resume quietly starts a fresh conversation, and the user loses model context with nothing recording why.

**Context.** Both fallbacks are deliberate: a comment on each says a new conversation beats a tab that can never send. Cursor's config-pending case already throws rather than fall back (`cursor-bridge/src/agent-session.ts:612-617`).

**Investigation.** `bridges/pi-bridge/src/agent-session.ts:1085-1088` catches `SessionManager.open` and clears `sessionFile`. `bridges/cursor-bridge/src/agent-session.ts:611-618` clears `agentId`. Neither logs. The `bridge.pi` and `bridge.cursor` vocabularies list no such event (`log-vocabulary/bridge.ts:241`, `:259`).

**Decisions.**

- **How far to go?**
  - **A `warn` with `formatLogError(error, { message: false })`, plus a one-line notice in the transcript (recommended).**
    - Pros: the report's "could not resume, started a new conversation"; `message: false` keeps provider text out.
    - Cons: the notice needs a transcript item both bridges can emit and the renderer shows.
  - **Log only.**
    - Pros: one line per bridge; ships today.
    - Cons: the user still does not know the agent forgot.

### 4. ACP exits and 500s, Cursor and Pi turn failures

**Problem.** These show only in UI state or an HTTP body, so a saved log has no trace.

**Context.** Pi and Cursor already log unexpected 500s without the error (`pi-bridge/src/http.ts:302`, `cursor-bridge/src/http.ts:246`). Codex has `http.request-failed`.

**Investigation.** `acp-bridge/src/acp-context.ts:1209` builds an error from code and signal and closes, with no log. `acp-bridge/src/acp-server.ts:53` answers 500 with the message and no log. Turn failures set `state.error` only: `pi-bridge/src/prompt.ts:447`, `:668`; `cursor-bridge/src/prompt.ts:471`, `:588`.

**Decisions.** None: one `warn` per site with static events and `{ message: false }`, matching `http.route-failed`'s stated reason that these errors can hold content. A turn the user cancelled is not a failure and stays out.

### 5. Storage swallows

**Problem.** A failed lease heartbeat or scrub checkpoint leaves no evidence.

**Context.** Report L4 also listed the change-tracking retention report; that belongs to [0810](0810-r19-database-observability.md).

**Investigation.** `storage-database.ts:1311-1319` swallows heartbeat failures ("a missed heartbeat only shortens the lease"). `storage-database.ts:926-930` swallows the checkpoint failure. The second matters because the scrub is a documented privacy step (`docs/architecture/storage.md:370-374`).

**Decisions.**

- **How to log a storage failure?**
  - **`log.throttled` keyed by lease name or `scrub`, with `recovered` on the next success (recommended).**
    - Pros: a fault gets one line and a summary, and a duration on recovery (`docs/architecture/logging.md:64-103`).
    - Cons: heartbeats pass through a second code path per lease.
  - **Count them in metrics only.**
    - Pros: no log lines.
    - Cons: a count that resets on restart explains nothing afterwards.

## Current state

Already done from report L4's table, so not tasks here:

- Environment deletion side steps log `delete.step-failed` (`commands-servers.ts:1611`, `:1696-1778`).
- Container bridge log retrieval exists for Cursor and Grok (`commands-registry-servers.ts:655`) and predates the report (`#492`, 2026-08-27). The report said there was none. No web or CLI client calls it; see [0740](0740-r6-docker-bridge-log-rotation.md).
- Bridge and backend errors go through `formatLogError` (R5).

## Constraints and rationale

- Every new event goes in `packages/protocol/src/log-vocabulary/`, content-free. `error.message` can quote a provider, so use `{ message: false }` where it might.
- These lines reach disk only while **Save Logs to Disk** is on. Capturing a first occurrence is [0750](0750-r6-essential-event-log.md), which depends on these events existing.

## Related

- [Logging and database report, R6](../2026-10-29-logging-and-database-efficiency.md#r6-an-always-on-essential-tier-that-closes-the-silent-gaps-l4) and [L4](../2026-10-29-logging-and-database-efficiency.md#l4-silent-failures-too-little-logging-high)
- [0002 session lifecycle consistency](../../todo/agent-engines/0002-session-lifecycle-consistency.md), which covers resume behaviour rather than its logging
- [Application logging](../../architecture/logging.md)
