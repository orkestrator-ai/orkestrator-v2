# E13: Silent failures

This file combines 2 reports into one batch to build together. Local bridge launch and exit.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0720](#0720-log-the-failures-that-are-still-silent) | High | R6's specific fixes (L4): writer lease, bridge exit, resume fallback, ACP, turn failures, storage swallows. |
| [0830](#0830-stop-inherited-vendor-debug-variables-reaching-local-bridges) | Medium | R10's environment item and L10: filter inherited vendor debug variables. |

## 0720: Log the failures that are still silent

### Task analysis

#### Tasks

1. **Writer lease loss**: log it and tell the user schedules have paused. Status: logging done; the notice is open.
2. **Local bridge exit**: log code and signal. Status: done.
3. **Pi and Cursor resume fallback**: log it and surface it. Status: logging done; the notice is open.
4. **ACP exits and 500s, Cursor and Pi turn failures**: log them at `warn` with bounded fields. Status: done.
5. **Storage swallows**: SQLite lease heartbeat and WAL scrub failures. Status: done.

#### 1. Writer lease loss

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

#### 2. Local bridge exit

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

#### 3. Pi and Cursor resume fallback

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

#### 4. ACP exits and 500s, Cursor and Pi turn failures

**Problem.** These show only in UI state or an HTTP body, so a saved log has no trace.

**Context.** Pi and Cursor already log unexpected 500s without the error (`pi-bridge/src/http.ts:302`, `cursor-bridge/src/http.ts:246`). Codex has `http.request-failed`.

**Investigation.** `acp-bridge/src/acp-context.ts:1209` builds an error from code and signal and closes, with no log. `acp-bridge/src/acp-server.ts:53` answers 500 with the message and no log. Turn failures set `state.error` only: `pi-bridge/src/prompt.ts:447`, `:668`; `cursor-bridge/src/prompt.ts:471`, `:588`.

**Decisions.** None: one `warn` per site with static events and `{ message: false }`, matching `http.route-failed`'s stated reason that these errors can hold content. A turn the user cancelled is not a failure and stays out.

#### 5. Storage swallows

**Problem.** A failed lease heartbeat or scrub checkpoint leaves no evidence.

**Context.** Report L4 also listed the change-tracking retention report; that belongs to [0810](0750-e15-health-and-diagnostics.md#0810-database-observability).

**Investigation.** `storage-database.ts:1311-1319` swallows heartbeat failures ("a missed heartbeat only shortens the lease"). `storage-database.ts:926-930` swallows the checkpoint failure. The second matters because the scrub is a documented privacy step (`docs/architecture/storage.md:370-374`).

**Decisions.**

- **How to log a storage failure?**
  - **`log.throttled` keyed by lease name or `scrub`, with `recovered` on the next success (recommended).**
    - Pros: a fault gets one line and a summary, and a duration on recovery (`docs/architecture/logging.md:64-103`).
    - Cons: heartbeats pass through a second code path per lease.
  - **Count them in metrics only.**
    - Pros: no log lines.
    - Cons: a count that resets on restart explains nothing afterwards.

### Current state

Tasks 1 to 5's logging is in, with the events listed in
[Application logging](../../architecture/logging.md#failures-that-would-otherwise-leave-no-trace).

Already done from report L4's table, so not tasks here:

- Environment deletion side steps log `delete.step-failed` (`commands-servers.ts:1611`, `:1696-1778`).
- Container bridge log retrieval exists for Cursor and Grok (`commands-registry-servers.ts:655`) and predates the report (`#492`, 2026-08-27). The report said there was none. No web or CLI client calls it; see [0740](0740-e14-docker-logs.md#0740-keep-the-previous-docker-bridge-log-across-a-relaunch).
- Bridge and backend errors go through `formatLogError` (R5).

### Constraints and rationale

- Every new event goes in `packages/protocol/src/log-vocabulary/`, content-free. `error.message` can quote a provider, so use `{ message: false }` where it might.
- These lines reach disk only while **Save Logs to Disk** is on. Capturing a first occurrence is [0750](0750-e15-health-and-diagnostics.md#0750-an-always-on-essential-event-log), which depends on these events existing.

## 0830: Stop inherited vendor debug variables reaching local bridges

### Task analysis

#### Tasks

1. **Filter vendor debug variables on local bridge launch**: with a documented way to keep them. Status: open.

#### 1. Filter vendor debug variables on local bridge launch

**Problem.** A stray `DEBUG`, `RUST_LOG` or `DEBUG_CLAUDE_AGENT_SDK` in the shell that launched Orkestrator turns on vendor debug output in a bridge. That output is not a logger call, so it is captured whatever the level is, and a vendor's debug text can hold prompts or tool content.

**Context.** Report L10 and R10. Since the report, levels and the structured log are in place, but raw output bypasses them by design: "output that is not a logger call ... is captured as text whatever the level is" (`docs/architecture/logging.md:583-584`). AGENTS.md invariant 12 keeps file and terminal contents out of logs.

**Investigation.** `commands-servers.ts:961` builds the local bridge environment from `...process.env`. A search of `apps/backend/src`, `packages/protocol/src` and `bridges/*/src` finds no reference to `DEBUG_CLAUDE_AGENT_SDK` or `RUST_LOG` and no filter. `configureBridgeLogger` consumes only Orkestrator's own relay, format and level variables, so agent commands do not inherit those (`logging.md:656-661`). Container bridges do not inherit the host environment at all.

**Decisions.**

- **How to filter?**
  - **Remove a short named list (`DEBUG`, `RUST_LOG`, `DEBUG_CLAUDE_AGENT_SDK`) in the local launch, unless `ORKESTRATOR_KEEP_VENDOR_DEBUG=1` (recommended).**
    - Pros: predictable; a one-line escape hatch to document, as the report asks.
    - Cons: a list needs maintaining, and a new vendor variable slips through.
  - **Honour them only from an explicit "advanced environment" field, as the report proposes.**
    - Pros: a user states intent where it can be seen.
    - Cons: the field is new settings surface for a developer need.
  - **Leave them and document it.**
    - Pros: no behaviour change; a developer exporting `DEBUG=…` gets what they asked for.
    - Cons: the shell setting is often forgotten, and the leak is silent.
- **What about agent commands?**
  - **The filter applies to the bridge process and what it spawns, as with today's relay variables (recommended).**
    - Pros: one rule; the vendor CLI is the child that honours most of these.
    - Cons: a command an agent runs in the worktree no longer inherits `DEBUG` from the launch shell. A project's own `DEBUG=x npm test` is unaffected.
  - **Strip it only from the bridge and restore it for tools.**
    - Pros: tool behaviour is exactly as now.
    - Cons: needs per-provider plumbing, and vendors spawn tools themselves.

### Current state

Nothing has landed. Split from [0850](0740-e14-docker-logs.md#0850-bound-docker-log-fallbacks-and-report-dropped-writes) because it can ship alone and is a privacy matter rather than a disk one.

### Needs verification

- Whether any supported provider needs one of these set in normal use. None was found, but vendor CLIs were not run.
- Whether an existing settings field already passes user-set variables to local bridges was not traced.

## Outstanding work

The user chose to do the logging first, so neither notice exists. What each needs:

- **Lost writer lease in Settings, Schedules.** An additive status field on the scheduled jobs answer, read from `registryWriterLease.isHeld()` (it reads as false for a lost lease and for a backend that never had it, so the field must tell those apart to word the notice; `RegistryWriterLease` would have to expose the state it now logs). A notice in the Schedules settings, shown only to someone with schedules, and a rehydrating read: a backend event alone would be missed by an unmounted screen. Older clients ignore the field and stay silent.
- **A transcript note that a resume fell back.** A status transcript item both bridges can emit, written where `session.resume-fell-back` is logged, and renderer support if the existing status row does not fit. Pi's `sessionManagerFor` and Cursor's `attach` run before a turn, so the item has to land in the transcript in step with its revision and survive a reload, in `normalize`-style replay as well as live. Fixed text only, never the provider's message.

## Assumptions and decisions

### Task 1: the lease module logs under `docker`

The lease guards container mutation and already formats its refusal as a container lifecycle error, so `writer-lease.*` joined that area rather than a new one. A new area would cost two lines and tell a reader nothing more.

### Task 1: there is no regained event

`lost` is sticky, the heartbeat stops, and nothing reacquires: a lost lease lasts until the process restarts. A test pins this. A refresh racing `release` finds its own removal, so the transition ignores a released lease rather than warn at every shutdown.

### Task 2: stop intent is held per child, in `LocalServerRuntime.terminate`

`terminate` is the one path every requested stop takes, including replacement and shutdown, so it records the child in a `WeakSet`. Reporting does not depend on key ownership, because a replaced child no longer owns its key and its exit still explains what happened. A bridge that crashes in the moment before a stop is requested reads as requested. A bridge that exits before it is healthy also logs, beside the startup error that already reported it.

### Task 4: a normal ACP close is `debug`, not `warn`

The bridge closes agent processes on every session close, replacement and shutdown (`#terminationOutcome === "resolved"`). A `warn` on each would make the line useless, so only an exit nothing asked for, or a fault-driven termination, warns. Client hang-ups are left out of `http.route-failed` too, because the aborted route rejects with no one waiting.

### Task 4: turn failure sites beyond the analysis

Re-checking found three more failures that set state only: Pi's refusal before a run (`http.ts`, `turn.refused`), Cursor's rejected `send` (`http.ts`, `turn.send-failed`), and a Cursor run recovered after a restart (`agent-session.ts`, `turn.recovery-failed`). Each got its own event. `turn.failed` skips a turn the user or Pi cancelled, which needs one new unpersisted field on each bridge's state (`turnCancelRequested`), because a cancel can also make the run reject.

### Task 5: a blocked scrub counts as a failure

`PRAGMA wal_checkpoint(TRUNCATE)` reports a reader blocking it as `busy=1` in its result row and does not throw, so logging only the existing `catch` would have missed the common case. The scrub now reads that row and logs `kind=busy`. Nothing else about the scrub changed, including the time it can wait on a reader, which is [0800](0800-r18-scrub-checkpoint-stall.md).

## Related

- [Logging and database report, R6](../2026-10-29-logging-and-database-efficiency.md#r6-an-always-on-essential-tier-that-closes-the-silent-gaps-l4) and [L4](../2026-10-29-logging-and-database-efficiency.md#l4-silent-failures-too-little-logging-high)
- [0002 session lifecycle consistency](../../todo/agent-engines/0002-session-lifecycle-consistency.md), which covers resume behaviour rather than its logging
- [Application logging](../../architecture/logging.md)
- [Logging and database report, R10](../2026-10-29-logging-and-database-efficiency.md#r10-docker-log-hygiene-l9) and [L10](../2026-10-29-logging-and-database-efficiency.md#l10-consistency-low)
- [Application logging](../../architecture/logging.md#the-bridge-hop)
