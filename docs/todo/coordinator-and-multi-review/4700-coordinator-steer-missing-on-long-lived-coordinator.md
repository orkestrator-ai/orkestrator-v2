# Steer missing on a long-lived Coordinator during a mail-started turn

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`. Re-checked 2026-11-05 against `main` at `41f9eb638`: every finding in task 1 still holds, and the logging it recommended is now in.

### Tasks

1. **Capture the failing state**: record the Coordinator's projection when a typed message queues with no Steer. Status: done (2026-11-05): the logging is in. It records the state from the next occurrence on a release that has it; see [Current state](#current-state).
2. **Fix the cause once it is known**: make the queued row offer Steer, or say why it cannot. Reporting the next occurrence from the user's own saved log moved to the manual-test checklist. Status: blocked (waits on 7568: 4700 task 2 occurrence report).

### 1. Capture the failing state

**Problem.** On 2026-11-04 at about 08:28 UTC the user's main Coordinator (Claude, production 2.36.1) was busy with a turn and Auto-steer was on. A message the user typed sat as "1 queued" for about 1.5 minutes, with only edit and delete on its row: it was not auto-steered and there was no Steer button.

**Context.** The Coordinator page mounts the shared native tab (`CoordinatorPanel.tsx` renders `AgentNativeTab` with `executionPolicy="coordinator-read-only"`). Auto-steer and the row's Steer use the same gate in `AgentNativeTab.controller.tsx`: the turn is `running`, no dispatch is parked (`recoverableDispatch`), and the projection reports `capabilities.actions.steer`. The backend clears that capability only when `HttpBridgeProvider.steerSupported()` returns false, which is whenever its `GET /session/:id/steer/dispatch` qualification request fails (`http-bridge-provider.ts`, `.catch(() => false)` in `native-agent-transcript-projection.ts`).

**Investigation.** The failure did not reproduce. On an isolated `dev:test` profile with a live Claude coordinator, the projection reported `phase: running` and `actions.steer: true`. That held whether the busy turn was started from the composer or by `dispatch_native_agent_intent`. With Auto-steer off the queued row showed Steer, and with it on the message was steered and no row was left. The production log shows what was different about the user's turn. A system mail inject started it at 08:28:04 (`agent-mail inject.dispatched … via=inject`), and the bridge process had been running since before 04:33. Later mail waited with `reason=draft` and then `reason=working`. The turn closed at 08:30:18, and at 08:30:20 the bridge was replaced because the active agent account changed. The queued message was then delivered at 08:30:23. Nothing in the code paths read (projection, provider registry, bridge routes, command routing, the renderer's projection merge) treats a `coordinator:` runtime id differently. The production log has no content-free line recording the projection's steer capability, so the state at 08:28–08:30 cannot be reconstructed.

Re-checked 2026-11-05 against `41f9eb638`, reading the code rather than a live run:

- `steerSupported` still dropped a failed request, a non-OK answer and an unreadable body without a trace. `HttpBridgeProvider` is the only implementation.
- The transcript changes kept the `.catch(() => false)`, and there are two: the full projection and the progressive state read (`native-agent-transcript-projection.ts`). `steerSupported` handles its own failures, so neither catch can fire for an HTTP bridge.
- `queuedSteerNote` still gives no note when the turn is not running, and the gate in `AgentNativeTab.controller.tsx` is still running, nothing parked and `actions.steer`.
- New: the Claude and Codex bridges answer the qualification id `unknown` before any session lookup, and Pi and Cursor look it up in a journal that never holds it. A reachable Claude bridge with the route therefore always qualifies, so on Claude `actions.steer: false` needs the request itself to fail or answer non-OK. Other callers (build pipeline, Multi Review and branch mail) share `steerSupported`, so they write the same warning.

**Decisions.**

- **How to get evidence?**
  - **Log when steer qualification fails (recommended).** Add a rate-limited, content-free warning in `steerSupported` when the qualification request fails or answers non-OK (agent, status code or error class only), plus a debug line when a projection clears `actions.steer`.
    - Pros: the next occurrence names the cause; cheap; no prompt or session content is logged.
    - Cons: needs a release and another occurrence before it pays off.
  - **Reproduce live on a long-lived coordinator with mail-started turns and an account switch.**
    - Pros: could find the cause without waiting for a release.
    - Cons: needs several worker reports, two Claude accounts and billed turns; it may still miss a timing-dependent cause.

### 2. Fix the cause once it is known

**Problem.** Whatever made the row unsteerable is still unknown.

**Context.** Since this change, a row that cannot be steered while the turn runs says why under its text: the provider cannot steer, an earlier message is still being confirmed, attachments, a command, or the steer refusal itself (`queuedSteerNote` in `auto-steer.ts`). These notes expose only the listed blockers. If the renderer does not see the turn as running, an unparked row has no note and no Steer; a bare row therefore does not identify the cause. Qualification logging from task 1 now covers the provider blocker. For a bare row, 6640 (retired 2026-11-14; `git show dc90609bf:docs/todo/coordinator-and-multi-review/6640-queued-row-turn-not-running-evidence.md`) added a backend debug line, `queue.turn-not-running`, which says whether the backend itself saw the turn as running; see [Current state](#current-state).

**Investigation.** Not started; it waits for the user's report of an occurrence (the row, the time and the matching log lines; on the manual-test checklist), read with [Current state](#current-state).

**Decisions.**

- **Where to fix?**
  - **Decide after task 1 (recommended).** The fix depends on which gate closed.
    - Pros: no speculative change to steer qualification, which guards at-most-once steering.
    - Cons: the problem can recur until then.
  - **Cache a positive qualification per bridge connection now.**
    - Pros: a transient failed qualification read could no longer hide Steer.
    - Cons: there is no evidence yet that the read failed; it would also hide a bridge that has genuinely lost the route.

## Current state

The next occurrence can be read from the saved log, under these conditions:

- The release must contain these lines (added after `41f9eb638`).
- The warning reaches disk only while **Save Logs to Disk** is on. It is not an essential event, so `logs/essential/` does not hold it. Saving was on for the 2026-11-04 log.
- The debug lines (`steer.capability-cleared`, and `queue.turn-not-running` from releases after `dc90609bf`) need **Log Detail** at `native-agent=debug` as well, set before the occurrence. Without it, only the warning is available.

**Start from the row, then the time.** Note what the row showed and when, then search the daily log for that window:

```bash
grep -E 'steer\.qualification-failed|steer\.capability-cleared|queue\.turn-not-running' <daily log file>
```

| What the row showed | What it means |
| --- | --- |
| "cannot be steered here" | `actions.steer` was false: read the lines below for why. |
| "Waiting for the earlier message to be resolved" | A dispatch was parked. Qualification is not the cause. |
| A note about attachments, a command or a refused steer | That blocker. Qualification is not the cause. |
| No note and no Steer | The renderer did not see the turn as running. Read the `queue.turn-not-running` lines for that environment: see [A bare row](#a-bare-row). |

**The warning says why qualification failed.** These lines are real output from fake bridges:

```text
[native-agent] steer.qualification-failed scope=claude:<uuid> kind=http-404 agent=claude status=404
[native-agent] steer.qualification-failed scope=claude:<uuid> kind=ProviderUnreachableError agent=claude error.name=ProviderUnreachableError error.cause.name=Error error.cause.code=ConnectionRefused
[native-agent] steer.qualification-failed scope=codex:<uuid> kind=ProviderUnavailableError agent=codex error.name=ProviderUnavailableError error.cause.name=TimeoutError error.cause.code=23
[native-agent] steer.qualification-failed scope=pi:<uuid> kind=unexpected-answer agent=pi status=200
[native-agent] throttle.recovered site=steer.qualification-failed scope=cursor:<uuid> failures=1 kinds=1 suppressed=0 faultSeconds=0
[native-agent] steer.capability-cleared agent=claude environmentId=env-1 status=running
```

| Line | Reads as |
| --- | --- |
| `kind=http-<status>` | The bridge answered that status: for example 401 for a refused token, or 404 for a bridge that predates the route. |
| `kind=ProviderUnreachableError` | The request never connected, so the bridge was down or being replaced. |
| `kind=ProviderUnavailableError` | Connected but failed. `error.cause.name=TimeoutError` means it stopped answering within the request timeout. |
| `kind=unexpected-answer status=200` | A successful answer with an unreadable body or a `dispatch` other than `unknown` or `dispatched`. |
| `throttle.suppressed site=steer.qualification-failed` | The same fault repeated, counted once per minute. |
| `throttle.recovered site=steer.qualification-failed` | Qualification succeeded again. `faultSeconds` is how long this fault lasted. |
| `steer.capability-cleared` (debug) | A projection took steering away. `environmentId` names the environment and `status` the provider's turn status at that moment. |

### A bare row

A queued row with no note and no Steer means the renderer did not see the turn as `running`. The backend writes one debug line each time a session's projection holds queued prompts while its turn phase is anything but `running`, and again on each change of that phase (`QueuedTurnPhaseLog`, `native-agent-queued-turn-log.ts`). Real output from the logger:

```text
[native-agent] queue.turn-not-running agent=claude environmentId=env-1 phase=recovering queued=1
[native-agent] queue.turn-not-running agent=claude environmentId=env-1 phase=idle queued=2
```

| What the log shows around the time of the row | Reads as |
| --- | --- |
| A line for the environment with `phase=recovering`, `cancelling`, `error` or `blocked` | The backend did not see the turn as running either: the bridge was reconnecting or unreachable, or the turn was stopping, failed or blocked. A backend or bridge cause. |
| A line with `phase=idle` | The backend saw the turn finished with prompts still queued. If it repeats at every turn's end, that is a queue draining normally; one that the row outlived means the queue did not drain. |
| No line for the environment in the window (with **Log Detail** set) | The backend saw the turn as `running` while it held the queue, or held no queued item yet. Either way the renderer's view differed from the backend's: a renderer cause. |

The line carries the agent, the environment id, the phase and the number of queued items only. It never carries a prompt, a queued item, a provider session id or the tab's session key, so two tabs in one environment are not told apart. It is written once per change: a phase that stays the same writes nothing more, and a turn that goes back to `running`, or a queue that empties, re-arms it. The backend remembers the last phase of at most 256 sessions, so a session pushed out of that set may write its current phase again.

**Limits of the reading:**

- `scope` is one bridge connection. A replaced bridge gets a new scope, so a fault that ends in a replacement writes no recovered line for the old scope.
- Only the first line of a kind carries its detail, so a second cause under the same class is only counted.
- A fault that started earlier has its first line before the window, so search back from it. With saving on and no qualification line in or before the window, a failed request did not clear the capability. Use the row table above instead.

## Assumptions and decisions

### Task 1: logging added (2026-11-05)

Took the recommended option; the re-check showed it still fits.

- **The rate limit is `log.throttled`, scoped per provider instance.** Scoping by agent alone would let one environment's success report a recovery for another's fault. The scope is the agent plus a random id, following `TmuxSession`, so it carries no session id.
- **A fetch error keeps its class but not its message.** Its message can quote the URL, which holds the session id.
- **An unreadable or wrong 200 answer also warns**, as `unexpected-answer`. The ticket named a failed request and a non-OK answer, but this third path also returns false, and leaving it silent would make its absence from the log misleading.
- **The warning is not an essential event.** The essential list is curated and the ticket did not ask to extend it. The cost is that the line needs **Save Logs to Disk**.
- **The debug line is written from both read paths**, because either can clear the capability. It adds `environmentId` and `status`, which are identifiers rather than content, so a reader can tell whether the Coordinator's turn was running.
- **Steering behaviour is unchanged.** Every path returns what it returned before, and no positive qualification is cached.

Evidence is from fake bridges only: no real occurrence has been read yet.

### Task 1: the renderer's own view

A turn the renderer does not see as running cannot be logged cheaply. `isRunning` exists only in the renderer, and renderer logger lines stay in the browser console rather than reaching the saved log (`docs/architecture/logging.md`, "What stays out of the persistent log"). Carried to 6640 (retired 2026-11-14; `git show dc90609bf:docs/todo/coordinator-and-multi-review/6640-queued-row-turn-not-running-evidence.md`), which added the backend's side on 2026-11-14 ([A bare row](#a-bare-row)).

### Task 1: diagnostic limits

Clarified the existing notes' limits instead of adding speculative logging in this UI fix. Notes explain known renderer blockers but cannot reconstruct a missed running state or a bridge qualification failure. Live capture of the long-lived, mail-started production scenario remains open; the mocked controller tests do not qualify it.

### Task 2: current blockers precede refusal history

Current provider and item blockers now take priority over historical refusals, alongside recovery. Retaining bounded history preserves context when a row can be retried; wording describes capacity at the time of the attempt rather than the current turn. Clearing all history on idle would lose context before a queued row drains.

## Needs verification

- Whether the user's 2026-11-04 state was `actions.steer: false`, a parked dispatch, or a turn that the renderer did not see as `running`. The new lines cannot answer this for that date, only for the next occurrence.

## Related

- 6640 (retired 2026-11-14; `git show dc90609bf:docs/todo/coordinator-and-multi-review/6640-queued-row-turn-not-running-evidence.md`): the backend's phase line for a queued row whose turn is not running ([A bare row](#a-bare-row)). Reading it at a real occurrence is on the manual-test checklist (7568: 6640 (retired) task 1).
- Ticket cdc7a75f-3633-4353-8d86-112fd74654f1 (Coordinator chat auto-steer and Steer button).
- to-do 0740 (retired 2026-11-10; see [coordinator.md](../../architecture/coordinator.md#course-corrections-with-delivernow)) (mail steered into running turns).
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 2: reporting the next occurrence with its saved-log lines) moved there on 2026-11-10.
