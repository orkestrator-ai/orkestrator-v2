# 03 — Claude bridge: break up the 3,252-line `sendPrompt`

Status: In progress. Step 1 (`TurnState`, in
`session-manager-prompt-turn.ts`) landed 2026-10-15. Step 2 has started: `init`
and the leaf branches (`prompt_suggestion`, `rate_limit_event`, `auth_status`,
`stream_event`, `tool_progress`, `tool_use_summary`, `conversation_reset`) are
in `session-manager-prompt-handlers/`, and handlers take `(turn, message)`;
`system`, `assistant`, `user` and `result` are still inline. Step 3 is done: the
ownership, continuation and input closures are functions of `turn` in
`session-manager-prompt-turn-lifecycle.ts`, the hooks are in
`session-manager-prompt-hooks.ts`, `turnCanUseTool` is in
`session-manager-prompt-can-use-tool.ts`, and `thisTurn` comes from
`createClaudeRuntimeTurn`. Priority: third. Read
[`bridges/AGENTS.md`](../../bridges/AGENTS.md) and
[`bridges/claude-bridge/AGENTS.md`](../../bridges/claude-bridge/AGENTS.md)
before starting.

## Problem

`sendPrompt` in `bridges/claude-bridge/src/services/session-manager-prompt.ts`
runs from line 586 to 3837 as one exported function. It has no class or
inheritance; the size comes from one closure scope. The `SessionManager` is
already plain functions (`session-manager.ts` just does `export *`), working on
module-level registries in `session-manager-core.ts` and a `SessionState`
passed in.

### Phases inside the function

| Lines | Phase |
| --- | --- |
| 599–662 | Admission and validation: dedupe, deleting/running/rewind checks, `*BeforeStartup` snapshots, dispatch claims |
| 663–815 | Transcript hydration, attachments, building the user message |
| 816–918 | Turn state setup, `createPromptStreamState` (871), usage accumulator |
| 919–1030 | Query config: policy, MCP and plugins, permissions, tools, `buildSdkPrompt` |
| 1031–1497 | Small helper closures: steer input, turn ownership, usage publish, continuation watchdog, background-task release, compaction and task hooks, command changes |
| 1497–~1750 | `turnCanUseTool` (~250 lines) |
| 1750–~3117 | `handleMessage` (~1,370 lines), an `if/else` chain on message type |
| 3120–3143 | `thisTurn` object (`ClaudeRuntimeTurn`) bundling the closures |
| 3168–3257 | Join an already-running runtime |
| 3259–3529 | Launch a new runtime: `query({...})` 3282–3493, `createClaudeRuntime` |
| 3530–3684 | Await `turnEnded`; plan-rejection and continuation re-prompts call `sendPrompt` again (3610, 3656) |
| 3685–3762 / 3763–3836 | `catch` rollback / `finally` cleanup |

Inside `handleMessage`, `system` alone is about 530 lines (1947–2480) with its
own subtype chain, and `result` is about 235 lines (2786–3022).

### What makes extraction hard

About 30 mutable locals are shared across the closures. None of them are in
`PromptStreamState`:

- Function level (817–864): `sdkMessageCount`, `bootstrapClaudeUsage`,
  `transcriptHydrationFailed`, `displayPrompt`, `sdkTextPrompt`,
  `queryIteratorControl`, `runtime`, `thisTurn`,
  `resolveTurnEnded`/`rejectTurnEnded`, `superseded`,
  `inheritedContinuation`, `structuredUsageRefresh`, `queryStarted`,
  `queryEnded`, `closeSdkInput`, `finishTurnInputForThisTurn`,
  `turnReleasedToBackgroundTasks`, `releasedTurnStartedAt`,
  `retainedContinuationTimer`.
- Inside the `try`: `latestSteerUuid`, `receivedResult`,
  `receivedPromptResult`, `settlingResult`, `localCommandOutputSeen`,
  `lastThinkingTokensEmitAt`, `compactedTokensBefore`.
- Also captured: `stream`, `streamUsage`, `steerUuids`,
  `unansweredSteerUuids`, `abortController`, `turnGeneration`,
  `diagnostics`, and the `*BeforeStartup` snapshots.

## Target design

Keep `sendPrompt` as the public entry point. It becomes a short orchestrator,
roughly 150–250 lines:

```ts
export async function sendPrompt(...) {
  const admission = admitPrompt(session, input);               // may return early
  const prepared = await preparePromptInput(session, admission); // hydration + attachments
  const turn = createClaudeTurn(session, prepared, testHooks);   // TurnState + PromptStreamState
  try {
    const options = buildQueryOptions(session, turn);
    await attachOrLaunchRuntime(session, turn, options);
    return await awaitTurnAndFollowUps(session, turn);          // continuation / plan re-prompts
  } catch (error) {
    await rollbackFailedTurn(session, turn, error);
    throw error;
  } finally {
    finalizeTurn(session, turn);
  }
}
```

- **`TurnState`** (new, in `session-manager-prompt-turn.ts`) holds every flag
  listed above as named fields, plus the `stream: PromptStreamState` it
  already creates. Closures that read and write locals become functions of
  `(turn, …)`.
- **Message handlers** move to `session-manager-prompt-handlers/`, one module
  per message family: `init`, `system` (with its subtype table), `assistant`,
  `user`, `result`, plus a small module for the leftovers (`rate_limit`,
  `auth_status`, `stream_event`, `tool_progress`, `tool_use_summary`,
  `conversation_reset`, `prompt_suggestion`). `handleMessage` becomes a
  dispatch table:
  `const handler = handlers[msg.type] ?? handleUnknown; handler(turn, msg)`.
- **`turnCanUseTool`** moves to its own module, taking
  `(turn, session, toolName, input, opts)`.
- **`ClaudeRuntimeTurn` (`thisTurn`)** stays the boundary that the runtime
  calls into. It's built from `TurnState` by a factory instead of an object
  literal of closures.

## Order

Each step is one PR and keeps behaviour identical.

1. **Introduce `TurnState`.** Move the function-level `let`s into it,
   mechanically (`superseded` becomes `turn.superseded`). This is the
   enabling step and has no logic changes.
2. **Extract `handleMessage` branches**, starting with the small leaf
   branches, then `assistant`, `user`, `result`, and finally `system` with its
   subtype dispatch.
3. **Extract `turnCanUseTool`** and the hook closures (compaction,
   background tasks, command changes).
4. **Extract the phases**: admission, input preparation, query options,
   launch or join, await and follow-ups, rollback, finalize.
5. **Shrink `sendPrompt`** to the orchestrator above.

## Risks

- **Re-entrancy.** Continuation and plan-rejection call `sendPrompt`
  recursively (3610, 3656). The outer turn's `TurnState` must be finalized
  before the inner call starts, in exactly the current order.
- **Closure capture timing.** Some closures read a `let` assigned later, such
  as `runtime` and `thisTurn`. Moving them onto `turn.*` keeps the same
  late-binding behaviour; capturing the value early would not.
- **Rollback.** The `catch` uses the `*BeforeStartup` snapshots. Keep them on
  `TurnState`, captured at the same moment as today.
- **Bridge invariants.** Steer correlation, never awaiting rendering in the
  stream loop, and no session delete on close must all hold.

## Tests

This is well covered: about 290 `sendPrompt` / `runPromptWithMessages` calls
across 19 test files. The heaviest are `session-manager-prompt.test.ts`
(109), `session-manager-background-tasks.test.ts` (56) and
`session-manager-interactions.test.ts` (33). The harness is
`runPromptWithMessages` in `session-manager-test-harness.ts:318`. Run the full
claude-bridge suite after every step. Extracted handlers also get direct
table-driven tests: given a `TurnState` fixture and a message, assert the
emitted events and state changes.

## Done when

- No function in `session-manager-prompt*.ts` exceeds about 300 lines.
- `handleMessage` is a lookup table.
- No mutable `let` is shared across function boundaries outside `TurnState`.
