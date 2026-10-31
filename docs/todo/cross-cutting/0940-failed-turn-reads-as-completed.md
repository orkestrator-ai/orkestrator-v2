# A failed agent turn is announced as "The agent completed its work."

Found on 2026-10-29 while qualifying
[0235](../agent-engines/0235-codex-refused-login-turn-invisible.md) in profile
`qa-0235b`. A Codex turn refused with a 401 raised the toast "Agent finished:
refused-login-…: The agent completed its work." while the tab showed the error.

## Task analysis

Analysed 2026-10-29 against `main` at `79f3bc97`; re-checked and implemented 2026-10-30 against `main` at `cd7bbe3e`; task 3 re-checked and implemented 2026-10-31 against `main` at `931e5541`.

### Tasks

1. **Give a failed turn its own unread reason**: record and show a failure, not "completed its work". Status: done (2026-10-30). `agent_failed` is recorded on a failed turn's end and the toast reads "Agent stopped with an error".
2. **Check every platform reports a failed turn the same way**: Status: done (2026-10-30) against stubs; a live failed turn per provider was not run (see Needs verification).
3. **A failed turn the backend did not watch end**: a turn that fails while the backend is restarting, or whose bridge dies under it, still rings `agent_finished`. Status: done (2026-10-31) against fake bridges and a restart harness; a live restart and crash were not run (see Needs verification).

### 1. Give a failed turn its own unread reason

**Problem.** When a turn fails (a refused login, a provider error, a restart mid-turn), the environment is marked unread with `agent_finished`. The toast then says "The agent completed its work." That is wrong, and it sends the user to a tab expecting an answer.

**Context.** `EnvironmentUnreadReason` (`apps/backend/src/core/models.ts:243`, `apps/web/src/types/index.ts:89`) has `agent_finished`, `agent_ready`, `agent_waiting`, `agent_question`, `terminal_finished` and `marked_unread`; nothing for a failure. The copy is in `apps/web/src/components/environments/environmentUnreadToast.tsx:10-35`.

**Investigation.** The reason is chosen from the session's activity state, not from how the turn ended. `native-agent-launch-activity-reconciler.ts:1121-1132` treats any `working → idle` edge as a completion and records `agent_waiting` or `agent_finished`. `storage-projects.ts:1405` makes the same choice for the aggregate. A failed turn goes `working → idle` (or `error`, read as idle) like a successful one. Not checked yet: whether every provider's activity snapshot says the turn failed (`turn.phase: "error"`, a session `error`). The Codex bridge does (`phase: "failed"`).

**Decisions.**

- **How is a failure reported?**
  - **Add an `agent_failed` unread reason, set when the turn's terminal state is an error, with copy such as "Agent stopped with an error" (recommended).**
    - Pros: honest; it works with the existing unread, toast and sidebar paths; old clients fall back to `UNKNOWN_REASON_COPY` ("New activity"), which is still not wrong.
    - Cons: a new value in a persisted enum, so the storage, CLI and mobile readers that switch on it must accept it.
  - **Keep `agent_finished` but make the copy neutral ("The agent stopped").**
    - Pros: no protocol change.
    - Cons: the user still cannot tell a failure from an answer before opening the tab.
- **What counts as failed?**
  - **The provider's terminal error for the turn (session `error` or `turn.phase: "error"`), not a stop the user asked for (recommended).**
    - Pros: matches the tab's error row (`native-terminal:error:`).
    - Cons: needs the reconciler to read the turn outcome as well as the activity state.
  - **Any turn with an error notice.**
    - Pros: simpler.
    - Cons: notices outlive turns, so a later good turn could be reported as failed.

### 2. Check every platform reports a failed turn the same way

**Problem.** Task 1 only helps where the activity snapshot carries the failure.

**Context.** Bridge platforms report session state differently: Claude, Codex, Cursor, Grok and Pi over HTTP; OpenCode through its SDK.

**Investigation.** Not started.

**Decisions.**

- **How is it checked?**
  - **A backend test per platform that drives a failed turn through the reconciler and asserts the reason (recommended).**
    - Pros: cheap; the provider stubs in `native-agent-service-projection-test-support.ts` already model a failed turn per platform.
    - Cons: proves the stub, not each real provider.
  - **A live failed turn per provider.**
    - Pros: real evidence.
    - Cons: six live runs for a label.

### 3. A failed turn the backend did not watch end

**Problem.** Task 1 reads the outcome on the per-session turn-end edge. Two ends of a turn have no such edge, so they still announce "The agent completed its work."

**Context.** After a backend restart, a session's first observation has no prior state. The environment aggregate's `working → idle` fallback then rings the bell (`storage-projects.ts`, `completionTransition` in `setEnvironmentAgentActivity`), and that path picks `agent_waiting` or `agent_finished` from the aggregate alone. Separately, when no bridge answers for a group (`observeProvider` returns nothing, or the bridge is known absent), the reconciler records each session `idle` with no observation (`native-agent-launch-activity-reconciler.ts`, the `!provider` branch), so a bridge that crashed mid-turn reads as a finished turn.

**Investigation.** Done 2026-10-31; the outcome is under [Assumptions and decisions](#task-3-what-was-found). The reading above held, and there were three more ends: a bridge replaced before the next sweep, a session the bridge proves gone across a restart, and non-native sources that ring the same aggregate bell (split out to [1060](1060-non-native-activity-bell-reads-as-finished.md)).

**Decisions.**

- **What does the restart fallback say?**
  - **Pass the sweep's per-session `turnFailed` answers to `setEnvironmentAgentActivity`, and record `agent_failed` when any session that ended in this sweep failed (recommended).**
    - Pros: the same evidence task 1 uses; no extra read.
    - Cons: one more option on a storage call several sources share.
  - **Leave it.**
    - Pros: nothing to change; it only fires for a turn that ended across a restart.
    - Cons: that turn is still misreported.
- **What does a bridge lost mid-turn say?**
  - **`agent_failed`: a session seen `working` whose bridge is gone did not finish its turn (recommended).**
    - Pros: honest; the tab shows the turn cut short.
    - Cons: an environment stop that bypasses `settleStoppedRuntimes` would be reported as a failure.
  - **Keep `agent_finished`.**
    - Pros: no risk of calling a deliberate stop a failure.
    - Cons: a crash reads as finished work.

## Assumptions and decisions

Made 2026-10-30 while implementing tasks 1 and 2 against `main` at `cd7bbe3e`. Nothing from either task had merged before this work: `EnvironmentUnreadReason` had no failure value and the reconciler still chose `agent_waiting` or `agent_finished` from the activity state alone.

### Task 1: how a failure is reported

- **Chose:** the recommended option, a new `agent_failed` value of `EnvironmentUnreadReason` (backend `models.ts`, web `types/index.ts`) with the toast copy "Agent stopped with an error" / "The agent's turn failed before it finished. Open the tab to see the error."
- **Why:** it is the only option that lets the user tell a failure from an answer before opening the tab. The persisted-enum cost the analysis warned about turned out to be small: nothing validates the value on load, and no CLI, mobile or storage reader switches on it. The only readers are the web toast (an exhaustive `Record`, so the typecheck forces the new copy) and `recordEnvironmentSessionCompletion`, whose parameter type now allows it. An older web client shows `UNKNOWN_REASON_COPY` ("New activity").

### Task 1: what counts as failed, and where it is read

- **Chose:** the recommended rule, the provider's terminal error for the turn and not a stop the user asked for. It is read from a new optional `turnFailed: true` field on the bridges' no-touch activity observation (`SessionActivityObservation` in `packages/protocol/src/session-activity-batch.ts`, for both `GET /session/:id/activity` and `POST /sessions/activity`), not from a session status read.
- **Why:** the first version read `readProviderStatus` on the turn-end edge. That broke the existing invariant test "observation never starts a bridge, hydrates or touches a session" (`native-agent-service-reconciliation.test.ts`). The session snapshot route is a liveness touch: Codex refreshes `lastAccessed` and Claude hydrates the transcript. Even one read per edge would undo the no-touch contract, so the outcome now travels with the activity answer. Each bridge sends `turnFailed` exactly when its session status is `error`. That is the same rule the session snapshot already uses for a failed turn, and every bridge settles a user stop to idle with no error: Claude `abortSession`, Codex `interrupted` with `cancelRequested`, Cursor `cancelled`, Pi `turnAborted`, and ACP's `turnTerminalError`, which skips a user cancel. A bridge that predates the field sends nothing, and its turns ring `agent_finished` as before.

### Task 1: providers that keep a failure off their lifecycle

- **Chose:** on a turn-end edge whose observation has no `turnFailed`, a provider with `turnTerminalError` (OpenCode, Grok) is asked for the latest dispatched request's outcome. A non-null answer other than the user's own stop rings `agent_failed`. An unreadable answer rings `agent_finished`.
- **Why:** OpenCode's lifecycle reads idle after a failed turn and keeps the error on the request's answer, and Grok's bridge journals a turn it cut short (an unanswered request, a policy loop) while the session stays idle. Both reads are journal or transcript reads, not session touches, and they run only on an edge. OpenCode answers a user stop with "Query stopped by user.", so that string is now the shared `TURN_STOPPED_BY_USER_MESSAGE` in `agent-provider-contract.ts` (used by `opencode-messages.ts`). Workflows still read it as a failed turn; the bell does not. A provider with neither activity route, which falls back to a status read, reports `error` as `turnFailed` too (`native-agent-activity-reads.ts`).

### Task 2: how every platform is checked

- **Chose:** the recommended option, backend tests that drive a failed turn through the reconciler for every platform, plus one assertion per bridge that its activity route sends the field.
- **Why:** `native-agent-failed-turn-attention.test.ts` runs Claude, Codex, Cursor, Grok and Pi through the real HTTP provider against a stubbed bridge. It asserts `agent_failed` for a failed turn and `agent_finished` for a finished or stopped one, and that the edge reads only no-touch routes. It also covers Grok's journal-only failure and an unreadable journal, and OpenCode's failure, user stop and success. The analysis expected the stubs in `native-agent-service-projection-test-support.ts` to model a failed turn per platform; they do not (only a `status` callback), so the bridge tests drive the real HTTP parsing instead. Each bridge's own suite now checks its activity answer after a real failed turn: `session-manager-prompt.test.ts` (Claude), `app-server-runtime-lifecycle.test.ts` (Codex), `prompt.test.ts` (Cursor and Pi) and `acp-prompt.test.ts` (Grok, through a killed agent process).

### Task 3: split out

- **Chose:** to record the restart and crash ends as task 3 here rather than widen this change.
- **Why:** neither has a per-session edge to read the outcome on, so each needs a change to a different path (the aggregate fallback, the bridge-absent branch), and the crash case needs a decision about deliberate stops.

### Task 3: what was found

Made 2026-10-31 against `main` at `931e5541`. Every path that could ring `agent_finished` for a turn nobody watched end, and what it does now:

| End of the turn | Before | Now |
| --- | --- | --- |
| Bridge dies, next read fails, then no bridge is found | `agent_finished` from the session edge | `agent_failed` |
| Backend restart, bridge survives, turn failed meanwhile | `agent_finished` from the aggregate | `agent_failed` from the session's first answer |
| Backend restart, bridge gone (the usual local case: bridges exit with their backend) | `agent_finished` from the aggregate | `agent_failed` when the latest dispatched turn has no recorded end |
| Bridge replaced before the next sweep, restored session reads idle | `agent_finished` from the session edge | `agent_failed` from the bridge's own report (below) |
| Backend restart, bridge proves the session gone | `agent_finished` from the aggregate | `agent_failed` |
| Runtime stopped across a restart | Nothing: storage clears activity when it records a stop | Nothing (pinned by a test) |
| Multi Review, graph runs, terminal agents | `agent_finished` from the aggregate | Unchanged; see [1060](1060-non-native-activity-bell-reads-as-finished.md) |

What each provider reports after its own restart:

- **Claude:** the turn-in-flight mark restores the session as `error`, so `turnFailed`.
- **Codex:** a turn its dead predecessor left unfinished settles `failed`, so `turnFailed`.
- **Cursor, Grok, Pi:** the session restores idle with no error, and the journal holds the request as `ambiguous`, so `GET /session/:id/dispatch` answers `lost`.
- **OpenCode:** the provider has no restart journal. A failure on the request's answer is read as in task 1. A server replaced before the next sweep, with nothing on the answer, still reads as finished: nothing durable says otherwise, and the window closes when a failed read leads to the no-bridge path instead.

### Task 3: what the restart fallback says

- **Chose:** a variant of the recommended option. It uses the same evidence but rings from the session rather than through a new `setEnvironmentAgentActivity` option. Where the durable `native-agent` source says `working` and has done since before this process, a session's first idle answer asks `readTurnFailed`. A "yes" records `agent_failed` through `recordEnvironmentSessionCompletion`, which also turns the aggregate fallback off for that sweep. A "no" stays quiet and the fallback rings `agent_finished` as before.
- **Why:** passing answers to the storage call only helps when the aggregate goes idle in that same sweep. A sibling tab still working would keep it `working`, and by the time it went idle the failed session's answer would be gone. The session ring has no such gap, and the `attentionRecorded` path it needs already existed.
- **Bound on the evidence:** `unwatchedWorkingEnvironments` holds an environment only from its first sweep in this process until each of its sessions has answered, so a tab opened later inherits nothing. A durably idle environment rings nothing, however stale the bridge's `turnFailed`. Each session's first answer there costs at most two no-touch reads (the turn outcome and the dispatch status), once per restart. An unreadable outcome backs the group off and withholds the environment, as on a watched edge, so the turn is not announced as finished in the meantime.

### Task 3: what a bridge lost mid-turn says

- **Chose:** the recommended option, `agent_failed`, for a session seen `working` whose bridge is gone. A turn already released to background work has no edge and rings nothing, as before.
- **Across a restart** there is no per-session state, so the session must also have a latest dispatched request with no recorded outcome and no recorded stop. An environment whose session has neither falls back to `agent_finished`.
- **A session the bridge proves gone** counts the same way, because its turn cannot have finished.

### Task 3: telling a deliberate stop from a crash

- **Chose:** two checks, because the analysis's worry was real: `settleStoppedSessions` runs after a stop takes effect, so a sweep can find the bridge gone first. `runtimeStopRequested` is called before `stopLocalServerUnlocked` terminates a bridge (environment stop, move, delete, single-bridge stop) and before a container stop or rebuild. For `RUNTIME_STOP_REQUEST_WINDOW_MS` (two minutes) a missing bridge keeps `agent_finished`. A stop the user asked for is read from `interruptedRequestIds`, so stopping a turn and then losing the bridge is not a failure.
- **Why not a stop fence that withholds the group:** it would need clearing on every failure path, and keeping the bell an old stop already rang is no regression.

### Task 3: the `lost` read

- **Chose:** on a turn-end edge with no `turnFailed` and no terminal error, ask `dispatchStatus` for the latest request and treat `lost` as a turn cut short. A failed read, or any other answer, changes nothing and does not back the group off. Skipped for OpenCode, which never answers `lost` and would pay a transcript read.
- **Why not compare bridge connection identities:** a container bridge can come back on the same port, and the identity is in memory, so it says nothing after a backend restart. `lost` is durable and the bridge's own statement.
- **Known looseness:** Claude answers `lost` for any id restored from an earlier process, including a finished one. It only matters where a Claude bridge restarted and the durable source says `working` while another platform's tab held the turn. Such a bell says "failed" for a session whose turn finished, and the tab shows the truth.

## Needs verification

- A real backend restart and a real bridge crash mid-turn, in a disposable profile, to confirm the bell reads "Agent stopped with an error". The tests drive the real sweep and HTTP provider against fake bridges, a port that stops answering, and a second service over the same storage. They do not start a real bridge or provider.
- A live failed turn per provider (for example a refused login), to confirm the real bridge sends `turnFailed` and the toast reads "Agent stopped with an error". The tests prove the contract against stubbed bridges and each bridge's own failure path, not each real provider. This needs billed or credentialed provider turns, which this work did not run.

## Related

- [0235-codex-refused-login-turn-invisible.md](../agent-engines/0235-codex-refused-login-turn-invisible.md)
- [1060-non-native-activity-bell-reads-as-finished.md](1060-non-native-activity-bell-reads-as-finished.md)
