# Mid-turn steer and interrupt

Checked against `main` at `31d0fb06` (2026-10-17).

Users should be able to redirect or stop a running turn without losing work, on
every provider whose vendor surface allows it. Steer and the graceful abort
ladder are live on Claude, Codex, Cursor and Pi. Claude's CLI now stays warm
between turns and releases itself after an idle window, so a follow-up is
written into the running process. What is left for Claude is a live model
catalogue, a warm first turn and collapsing the last per-process task maps.
OpenCode and Grok steer are blocked upstream and are recorded here.

## Current state

- Steer is on Codex, Claude, Cursor and Pi (`actions.steer` in
  `nativeAgentCapabilities()`, `packages/protocol/src/native-agent.ts`). The
  backend qualifies it at runtime with `HttpBridgeProvider.steerSupported`,
  which probes `/session/:id/steer/dispatch`. No platform is hard-coded.
- Abort ladder (`apps/backend/src/core/native-agent-service-dispatch.ts`): it
  calls `provider.abort`, waits up to `abortGraceMs` (default 5 s), then calls
  `hardAbort`, and records a stop notice naming the rung that fired.
- Claude (`bridges/claude-bridge/src/services/`):
  - `/abort` → `gracefulInterruptClaudeSession` (`Query.interrupt()`, returns
    `stillQueued`) in `session-manager-catalog.ts`. `/hard-abort` is the kill
    rung (`routes/session.ts`). `perTaskStopAffordance: true` is declared
    (`session-manager-prompt-query.ts`).
  - `steerClaudeSession` writes into the running CLI's input through
    `pushInput`, with a steer journal.
  - `session-manager-runtime.ts` owns one CLI per session. It stays open
    after every turn, warm or owning background work. A follow-up is written
    into that process, frames are routed to the turn that owns them, and
    `applyClaudeLiveSettings` restates model, permission mode, thinking budget
    and flag settings on the live process.
  - A prompt settles at its own result (`endTurnOnWarmRuntime` in
    `session-manager-prompt-turn-lifecycle.ts`), not when the process exits.
    The runtime closes its own input after `CLAUDE_BRIDGE_RUNTIME_IDLE_MS`
    (default 10 minutes) of silence with no foreground turn, live task or
    parked card, and at most `CLAUDE_BRIDGE_MAX_IDLE_RUNTIMES` (default 3) idle
    CLIs stay warm per bridge (`session-manager-runtime-idle.ts`). A window of
    0 restores closing input at turn end.
  - Launch-only settings (`claudeLaunchProfile`) that differ from a CLI that
    still owes work are refused with a `conflict` (409) rather than starting a
    second process (#950). A warm CLI that owes nothing is retired and the
    turn launches a new one (`joinableRuntime` in
    `session-manager-prompt-launch.ts`).
  - The continuation a task notification owes is a flag on the latest turn
    (`awaitingContinuation`) that stretches the idle window to
    `CONTINUATION_SILENCE_MS`; `retainedContinuationRequestIds` still reports it
    to backend workflows. `backgroundTaskControls`,
    `backgroundTaskCandidates` and `settlingBackgroundTasks` remain as
    task-to-process maps (`session-manager-background-tasks.ts`).
  - The task and compaction hooks are already registered (`TaskCreated`,
    `TaskCompleted`, `SubagentStart`, `PreCompact`, `PostCompact`).
  - The model catalogue still comes from a throwaway `maxTurns: 0` query
    (`getAvailableModelCatalog` in `session-manager-interactions.ts`). Account
    and MCP reads use the same kind of probe when no CLI is live (`createProbe`
    in `session-manager-catalog.ts`).
  - Bridge tests cover an idle steer reading back as `absent` and the
    interrupt receipt (`session-manager-catalog-steer.test.ts`,
    `routes/session.test.ts`), and the warm runtime's join, window, cap,
    replacement and reclaim (`session-manager-runtime-idle.test.ts`).
- Cursor: `Run.steer` with a bounded `steer-journal.ts`. Status comes from
  `onDidChangeStatus` (`prompt.ts`). `recoverActiveRun` (`agent-session.ts`)
  re-adopts a surviving run, and `cancelSurvivingRuns` (`cursor-runs.ts`)
  cleans up after a closed session.
- Pi: `steer(text, images)` and `followUp(text, images)` (`http.ts`), with
  `setSteeringMode` / `setFollowUpMode` from Pi's settings
  (`agent-session.ts`). The backend reads `/session/:id/queue` into
  `providerQueue` (`http-bridge-provider.ts`), and
  `mergeNativeAgentQueueItems` (`native-agent-service-projection.ts`) merges it
  into the projection queue.
- Grok: `actions: {}`. The dormant interjection extension
  (`bridges/acp-bridge/src/grok-interjection.ts`) runs only with
  `GROK_UNSAFE_EXPERIMENTAL_INTERJECTION=1` (`applyVendorUpdate` in
  `acp-session.ts`).
- OpenCode: no `steer` in its actions.

## Outstanding work

### Code

1. **Collapse the task-to-process maps into the runtime.** With one CLI per
   session, `backgroundTaskControls`, `backgroundTaskCandidates` and
   `settlingBackgroundTasks` only ever name that session's runtime. Make them
   runtime state fed by the `TaskCreated` / `TaskCompleted` / `SubagentStart`
   hooks and the `task_*` system messages, so `stopBackgroundTask` and
   `endClaudeRuntime` read the runtime instead of a per-control map. Keep the
   strict-owner rule: a stop never reaches a process that did not start the
   task.
2. **Live model catalogue.** Read models from `initializationResult()` on the
   live runtime instead of `getAvailableModelCatalog`'s throwaway query. Keep
   the probe only for the no-runtime case. Do the same for `createProbe` reads
   when a runtime is live.
3. **Warm first turn.** Use `startup()` / `WarmQuery` so the first turn in an
   environment does not pay the cold spawn. Neither is used today. Measure it.
4. **Cursor, low priority.** `SendOptions.local.force` for a wedged agent. It is
   unused; add it only if `recoverActiveRun` shows wedged agents in practice.

### Blocked

- **OpenCode steer** needs OpenCode 2.x: `POST /api/session/:id/prompt` with
  `delivery: steer`. Even 2.x has no expected-turn precondition, so a native
  `/steer` must not be advertised until one exists. See
  [0008-opencode-v2.md](0008-opencode-v2.md).
- **Grok steer** stays off. ACP v1 has no mid-turn input, and the Grok
  interjection extension stays behind its unsafe flag until an ACP equivalent
  exists.
- Neither gets a coordinator-only workaround.
  [0028-coordinator-consistency-gaps.md](../coordinator-and-multi-review/0028-coordinator-consistency-gaps.md) tracks the
  coordinator side of the same gap.

### Qualification

- Browser, inactive path, on Claude and Cursor: start a long turn, steer it,
  switch environment, return and reload. The steered message and its outcome
  must come back from the snapshot.
- Through the app, on one warm Claude CLI: a follow-up, a plan-mode toggle, a
  permission-mode change, a parked approval answered after a pause, and an MCP
  server added and removed between turns. Confirm the process id stays the
  same and the composer changes take effect. The bridge-level runs are below;
  the app path is not yet qualified.
- Measure the first turn again once item 3 lands.

## Constraints and rationale

### Warm Claude runtime (decided 2026-10-17)

Measured on this host with haiku, prompt to first assistant text. Bridge
level, through `POST /session/:id/prompt` (four or five follow-ups each):

| Build | First turn | Follow-up (median) | CLI between turns |
| --- | --- | --- | --- |
| `main` `31d0fb06` | 5.2 s | 3.5 s | none |
| This change, window 0 | 4.3 s | 3.5 s | a new process each turn |
| This change, default window | 4.6–5.2 s | 0.9–1.0 s | the same process |

A bare SDK probe (no settings, MCP or plugins) gave 2.1 s for a resumed cold
follow-up and 1.2 s for a warm one; the bridge's real launch options make the
cold path dearer. A launch-only change on a warm CLI (prompt suggestions on)
was accepted, the old process exited and one new process took over. With a
15 s window the CLI was gone 20 s after the last turn. Each warm Claude CLI
here held about 300–340 MB resident.

Decisions, each the option built:

1. **Idle window: 10 minutes, environment-configurable, 0 disables.**
   Cursor and Pi already detach after 10 minutes (`BridgeLifecycle`); Codex
   uses 30. Seconds would miss most conversational follow-ups, which arrive
   after the user reads an answer; 30 minutes would hold about 300 MB per tab
   long after anyone is looking. The window measures CLI silence. No route
   read extends it, because the backend polls `GET /session/:id` and
   `/activity`. `CLAUDE_BRIDGE_RUNTIME_IDLE_MS` is an operator knob and a kill
   switch, not a user setting yet.
2. **At most 3 idle warm CLIs per bridge, the one idle longest released
   first.** One bridge serves one environment, so this bounds memory per
   environment without backend coordination. A CLI owing a continuation is
   never released for capacity. `CLAUDE_BRIDGE_MAX_IDLE_RUNTIMES`; 0 means no
   warm CLIs.
3. **Live settings are restated; launch-only changes retire an idle CLI.**
   Model, mode, effort, thinking, fast mode, Ultracode and MCP servers already
   go through control requests on every join. A launch-only difference
   (policy, plugins, credentials, structured output, prompt suggestions, 1M
   context, agent, settings sources) retires a CLI that owes nothing and
   launches a new one after the old one exits. A CLI that owes work still
   answers 409, because replacing it would kill that work and running two would
   duplicate the conversation.
4. **No memory limit beyond the window and the cap.** About 300 MB per CLI
   times 3 is the per-environment ceiling for idle CLIs. Watching RSS would
   need a sampling loop for a bound the cap already gives.
5. **Restart forgets warm CLIs.** Nothing is persisted. A bridge that exits
   takes its CLIs with it (they read its stdio and exit on EOF), and the next
   prompt cold-starts from the rollout. A backend restart leaves a bridge that
   survives it running its own windows.
6. **Per-turn bookkeeping: retired now where the warm runtime replaces it.**
   Deleted: the turn-end drain (`closeTurnInput`, `closeSdkInput`), the
   continuation watchdog and its timer (`armContinuationWatchdog`,
   `RETAINED_CONTINUATION_TIMEOUT_MS`, the `retainedContinuationTimeoutMs`
   test hook), control retention (`retainQueryControl`,
   `retainedQueryControls`) and `closeQueryControlIfUnused`: 277 lines out of
   existing sources, against a new 215-line `session-manager-runtime-idle.ts`.
   Kept: the owed-continuation flag and `retainedContinuationRequestIds`,
   which backend workflows read to keep supervising a released dispatch, and
   the task-to-process maps (item 1), which carry the strict-owner stop rule.
7. **A prompt settles at its result.** `sendPrompt` no longer waits for the
   process to exit. A root loop the CLI resumes on its own later (a
   continuation it owed) reclaims the foreground through the latest turn and
   publishes its own idle edge; if the process ends under it, the foreground
   is handed back (`releaseOrphanedForeground`).
8. **A hard abort with nothing running leaves a warm CLI alone.** It answers
   `not_running` instead of killing the process and writing an interruption
   into the transcript. A CLI that owns live work or an owed continuation is
   still stopped.

### Standing constraints

- At-most-once dispatch holds for a prompt written into a warm CLI exactly as
  for a new one. The journal records a message write: the prompt's client uuid
  rides on the input message, and `result.user_message_uuid` stays the
  reconciliation link. A lost acknowledgement must never be left neither
  provably sent nor provably unsent. A join that fails before the write
  (settings, MCP, closed input) is a definitive 409 with nothing written; the
  idle window never fires while a prompt holds `abortController`.
- `rejected` is only a definitive refusal; ambiguity stays `unknown`.
- Unmount is not cancel.
- Never run two CLIs resumed from one rollout. Each would answer its own task
  notifications as the coordinator and duplicate agents; that is why
  launch-only differences get a 409 instead of a second process.
- An interrupt must not kill background tasks (`perTaskStopAffordance`).
- Missing steer is a `false` capability bit, not an error.

## Related

- [0002-session-lifecycle-consistency.md](0002-session-lifecycle-consistency.md) (steer
  history, close and cancel alignment).
- [0013-claude-bridge-prompt-stream-state.md](../backend-structure/0013-claude-bridge-prompt-stream-state.md)
  (the same Claude prompt files).
- [0004-composer-model-parameters.md](0004-composer-model-parameters.md) (mid-session
  parameter changes ride on item 1).
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
  for the Claude and Cursor runs.
- [platform-inconsistencies.md](../../architecture/platform-inconsistencies.md).

## Replaces

- `docs/plans/sdk-coverage/05-mid-turn-control-steer-and-interrupt.md`
- `docs/plans/sdk-coverage/15-adapter-simplification.md` (Claude warm query,
  model catalogue, background-task reconciliation)
- `docs/plans/sdk-coverage/10-composer-model-axes-and-settings.md`
  ("mid-session change via `setModel()`/`applyFlagSettings()`")
- `docs/plans/sdk-coverage-2026-09-06.md` (Claude §3.1; Cursor §6.3, §6.6;
  Pi §8.2; Tier 3 rows 25, 26 and 30)
