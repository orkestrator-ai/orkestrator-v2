# Cursor extension handlers left in the Grok-only ACP bridge

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3`, with the replay removal from [1202](../cross-cutting/1202-efficiency-review-follow-ups.md) task 6 (BR-16) applied.

### Tasks

1. **Decide what happens to the `cursor/*` handlers**: remove them, or keep them as a generic ACP extension. Status: open.
2. **Rename what is generic but carries Cursor's name**: `cursorTodos` and friends also serve Grok and standard ACP plans. Status: open (depends on 1).

### 1. Decide what happens to the `cursor/*` handlers

**Problem.** The ACP bridge still handles Cursor's own extension methods, though no launch runs Cursor on it. The handlers add code and tests to a sensitive module for an agent that uses another bridge.

**Context.** BR-16 removed only the tool metadata replay, because that was the part gated on `provider === "cursor"` and spawning a process per pass. Cursor runs on `bridges/cursor-bridge`; `apps/backend/src/core/commands-servers.ts` and `host-model-catalog-refresh.ts` send only Grok here, and the container entrypoint exports `ACP_PROVIDER=grok`.

**Investigation.** These are gated by method name, not provider, so a provider-id argument does not prove them unreachable: `isCursorTaskMethod` and `isCursorUpdateTodosMethod` dispatch at `bridges/acp-bridge/src/acp-session.ts:2312` and `:2316`. Grok's launcher record lists no acknowledged extension methods, and nothing here shows Grok sending a `cursor/` method, but no run against the real binary was made to confirm it. What goes with them: `applyCursorTask` and the child-directory pairing around `bumpCursorDiscoveryRevision` and `settledCursorAgentIds`, the `cursorTask` field on tool sources, `CURSOR_JSONL_SOURCE_PREFIX`, and most of `testing/fake-agent-prompt-cursor.ts` and the `cursor/task` cases in `acp-transcript.test.ts` and `acp-context.test.ts`. The fixtures still send these methods under the neutral `acp-fixture` provider.

**Decisions.**

- **Remove, or keep as a generic extension?**
  - **Remove them, after a Grok run confirms it never sends them (recommended).**
    - Pros: a large block of provider-specific state and persistence fields goes; `bridges/acp-bridge/AGENTS.md` keeps provider quirks to named providers, and these have no provider left.
    - Cons: a wide diff in `acp-tools.ts`; persisted `settledCursorAgentIds` and `cursorTaskPromptReported` fields have to keep loading from existing state files.
  - **Leave them.**
    - Pros: no risk to the suites.
    - Cons: the code keeps being maintained for nothing.

### 2. Rename what is generic but carries Cursor's name

**Problem.** Some names say Cursor about code every ACP agent uses, which reads as dead code and invites deleting something live.

**Context.** Comments in `acp-context.ts` say so: the session list covers "Cursor `updateTodos`, Grok `todo_write`, ACP `plan`".

**Investigation.** `SessionState.cursorTodos`, `CursorTodoItem`, `parseCursorTodos`, `mergeCursorTodos`, `stampCursorTodos` and `restoreCursorTodosFromMessages` serve the Grok and standard ACP paths too. `cursorTodos` is in memory only, while the persisted shapes in `acp-persistence.ts` read the transcript.

**Decisions.**

- **When to rename?**
  - **In the change that settles task 1 (recommended).**
    - Pros: one pass through the same lines, and the handlers that are left decide the right names.
    - Cons: waits on task 1.
  - **Separately, now.**
    - Pros: clearer today.
    - Cons: touches the same code twice.

## Constraints and rationale

- Generic ACP behaviour stays (`bridges/acp-bridge/AGENTS.md`, "Standard ACP first").
- Existing state files must keep loading.

## Needs verification

- That Grok sends no `cursor/` method. Not run against the real binary.

## Related

- [1202 task 6](../cross-cutting/1202-efficiency-review-follow-ups.md), BR-16
- [E20, ACP bridge report](../../reports/efficiency-logging-database/0240-e20-acp-bridge.md)
