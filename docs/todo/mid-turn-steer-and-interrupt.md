# Mid-turn steer and interrupt

Checked against `main` at `2459b05c` (2026-10-15).

Users should be able to redirect or stop a running turn without losing work, on
every provider whose vendor surface allows it. Steer and the graceful abort
ladder are live on Claude, Codex, Cursor and Pi. Claude has one gap left: its
CLI still closes at the end of every turn that leaves no background work. Each
such turn cold-spawns the next one, and composer changes between turns only
take effect at the next launch. Keeping that CLI warm also lets the per-turn
bookkeeping go and gives a live model catalogue. OpenCode and Grok steer are
blocked upstream and are recorded here.

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
  - `session-manager-runtime.ts` owns one CLI per session while background
    work is live. A follow-up is written into that process, frames are routed
    to the turn that owns them, and `applyClaudeLiveSettings` restates model,
    permission mode, thinking budget and flag settings on the live process.
  - Launch-only settings (`claudeLaunchProfile`) that differ from the running
    CLI are refused with a `conflict` (409) rather than starting a second
    process (#950).
  - At the end of a turn with nothing owed, `closeTurnInput` →
    `drainClaudeRuntime` (`session-manager-prompt-turn-lifecycle.ts`) closes the
    CLI's input. The continuation timer (`armContinuationWatchdog`,
    `RETAINED_CONTINUATION_TIMEOUT_MS`), `backgroundTaskControls` and
    `closeQueryControlIfUnused` exist because of that per-turn lifetime
    (`session-manager-background-tasks.ts`, `session-manager-prompt-turn-lifecycle.ts`).
  - The task and compaction hooks are already registered (`TaskCreated`,
    `TaskCompleted`, `SubagentStart`, `PreCompact`, `PostCompact`).
  - The model catalogue still comes from a throwaway `maxTurns: 0` query
    (`getAvailableModelCatalog` in `session-manager-interactions.ts`). Account
    and MCP reads use the same kind of probe when no CLI is live (`createProbe`
    in `session-manager-catalog.ts`).
  - Bridge tests cover an idle steer reading back as `absent` and the
    interrupt receipt (`session-manager-catalog-steer.test.ts`,
    `routes/session.test.ts`).
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

1. **Keep the Claude runtime open across idle turns.** Stop draining at
   `closeTurnInput` when nothing is owed. Add an idle detach that releases the
   CLI after an inactivity window, on the same policy the Codex bridge uses
   (`detachableThreads` in `bridges/codex-bridge/src/sessions/thread-registry.ts`).
   Re-create the runtime on the next request.
   - `/session/:id/activity` stays a no-touch read and must not extend the
     window.
   - Composer changes between turns then go through `applyClaudeLiveSettings`
     instead of a relaunch. Launch-only differences still answer `conflict`.
   - Done when a second prompt after an idle turn is written into the same CLI
     process, and an idle session releases its CLI after the window.
2. **Retire the per-turn bookkeeping** once item 1 lands: the continuation timer
   and watchdog, `backgroundTaskControls`, `closeQueryControlIfUnused` and the
   owed-continuation tracking. It becomes runtime state fed by the
   already-registered `TaskCreated` / `TaskCompleted` / `SubagentStart` hooks
   and the `task_*` system messages. Record the deleted line count in the PR.
3. **Live model catalogue.** Read models from `initializationResult()` on the
   live runtime instead of `getAvailableModelCatalog`'s throwaway query. Keep
   the probe only for the no-runtime case. Do the same for `createProbe` reads
   when a runtime is live.
4. **Warm first turn.** Use `startup()` / `WarmQuery` so the first turn in an
   environment does not pay the cold spawn. Neither is used today. Measure it.
5. **Cursor, low priority.** `SendOptions.local.force` for a wedged agent. It is
   unused; add it only if `recoverActiveRun` shows wedged agents in practice.

### Blocked

- **OpenCode steer** needs OpenCode 2.x: `POST /api/session/:id/prompt` with
  `delivery: steer`. Even 2.x has no expected-turn precondition, so a native
  `/steer` must not be advertised until one exists. See
  [opencode-v2.md](opencode-v2.md).
- **Grok steer** stays off. ACP v1 has no mid-turn input, and the Grok
  interjection extension stays behind its unsafe flag until an ACP equivalent
  exists.
- Neither gets a coordinator-only workaround.
  [coordinator-consistency-gaps.md](coordinator-consistency-gaps.md) tracks the
  coordinator side of the same gap.

### Qualification

- Browser, inactive path, on Claude and Cursor: start a long turn, steer it,
  switch environment, return and reload. The steered message and its outcome
  must come back from the snapshot.
- Measure Claude turn-start latency, and the time to the first token on a
  follow-up turn, before and after items 1 and 4. Record the numbers in the PR.

## Constraints and rationale

- At-most-once dispatch holds across the change. The journal records a message
  write: the prompt's client uuid rides on the input message, and
  `result.user_message_uuid` stays the reconciliation link. A lost
  acknowledgement must never be left neither provably sent nor provably unsent.
  Land items 1 and 2 together for that reason; half of the change leaves
  exactly that state.
- `rejected` is only a definitive refusal; ambiguity stays `unknown`.
- Unmount is not cancel.
- Never run two CLIs resumed from one rollout. Each would answer its own task
  notifications as the coordinator and duplicate agents; that is why
  launch-only differences get a 409 instead of a second process.
- An interrupt must not kill background tasks (`perTaskStopAffordance`).
- Missing steer is a `false` capability bit, not an error.

## Open questions

- Is one warm idle Claude CLI per tab affordable in memory and process count,
  or should the idle detach be aggressive (seconds rather than minutes)?

## Related

- [session-lifecycle-consistency.md](session-lifecycle-consistency.md) (steer
  history, close and cancel alignment).
- [claude-bridge-prompt-stream-state.md](claude-bridge-prompt-stream-state.md)
  (the same Claude prompt files).
- [composer-model-parameters.md](composer-model-parameters.md) (mid-session
  parameter changes ride on item 1).
- [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md)
  for the Claude and Cursor runs.
- [platform-inconsistencies.md](../architecture/platform-inconsistencies.md).

## Replaces

- `docs/plans/sdk-coverage/05-mid-turn-control-steer-and-interrupt.md`
- `docs/plans/sdk-coverage/15-adapter-simplification.md` (Claude warm query,
  model catalogue, background-task reconciliation)
- `docs/plans/sdk-coverage/10-composer-model-axes-and-settings.md`
  ("mid-session change via `setModel()`/`applyFlagSettings()`")
- `docs/plans/sdk-coverage-2026-09-06.md` (Claude §3.1; Cursor §6.3, §6.6;
  Pi §8.2; Tier 3 rows 25, 26 and 30)
