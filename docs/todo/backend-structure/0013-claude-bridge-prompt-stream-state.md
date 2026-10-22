# Claude bridge prompt stream state

Checked against `main` at `2459b05c` (2026-10-15).

`createPromptStreamState` in the Claude bridge turns the SDK's streamed
frames into transcript rows. It carries the bridge's transcript-row rules (one
row per model response, late updates finding their row, bounded state, rows
shared across a turn handoff), yet it is tested only indirectly through
`sendPrompt`. It is also the one function left in `session-manager-prompt*.ts`
over the 300-line cap set when `sendPrompt` was broken up in #984. The work is
to give it direct tests first, then split its per-token delta handler and move
turn concerns out of it.

## Current state

- `createPromptStreamState` in
  `bridges/claude-bridge/src/services/session-manager-prompt-stream.ts` is
  one factory of about 630 lines. It is a class written as a closure: private
  `let`s and maps (flush timer, rows, row indexes, current row, sequence,
  current streamed API message id, dirty rows), about twenty short closures
  over them, and a returned object typed as `PromptStreamState`.
- Its parts: row bookkeeping (`forgetRow`, `createRow`, `rowForApiMessage`,
  `getBlocks`, `materializeEntryValue`, `rebuildOrderedParts`); publishing
  (`emitRow`, `newestRowMessage`, `insertAfterAnchor`, `materializeRow`); delta
  coalescing (`flushStreamedAssistantMessage`,
  `scheduleStreamedAssistantMessageFlush`); `applyAssistantRecord` and
  `refreshToolRows`; and `applyPartialAssistantMessage`.
- `applyPartialAssistantMessage` is the only long closure (about 130 lines).
  It handles `message_start`, `message_stop`, `content_block_start` and
  `content_block_delta` in one body, with a nested `appendStreamedDelta`.
- Bounds and constants in the same module: `MAX_STREAM_CONTENT_BLOCK_INDEX`
  (4,095), `MAX_TRACKED_STREAM_ROWS` (256), `MAX_SUBAGENT_PARTS_PER_CALL`
  (128). `MAX_STREAM_CONTENT_BLOCK_INDEX` already has a single definition;
  `session-manager-prompt-admission.ts` re-exports it.
  `STREAM_EVENT_COALESCE_MS` (100) lives in `session-manager-prompt-admission.ts`.
- `sessionStreamRows` is a module-level `WeakMap` keyed by session, which lets
  a released turn and its successor agree on API message identity.
- The plan-mode flags `pendingPlanRejectionFeedback`, `planApprovedThisTurn`
  and `pendingPlanApprovalContinuation` are on `PromptStreamState`, but only
  turn code reads or writes them: `session-manager-prompt-can-use-tool.ts`,
  `session-manager-prompt-settle.ts` and the `user` and `assistant` handlers in
  `session-manager-prompt-handlers/`. The comment above them still points at
  "the permissionMode site above", which now lives in
  `session-manager-prompt-query.ts`.
- There is no `session-manager-prompt-stream.test.ts`. The only test that
  calls `createPromptStreamState` directly is "an API response crossing a
  released-turn handoff adopts its existing row" in
  `session-manager-prompt.test.ts`. `session-manager-prompt-handlers/turn-fixture.ts`
  builds a stream state for handler tests. Everything else is covered through
  `sendPrompt` (`session-manager-prompt.test.ts`,
  `session-manager-transcript-revision.test.ts`,
  `session-manager-catalog-steer.test.ts` and others).
- Other prompt-module functions near the cap, for reference: `turnCanUseTool`
  (251 lines), `handleResultMessage` (240) and `claudeQueryOptions` (236).

## Outstanding work

### Code

Each step is one PR and keeps behaviour identical. Read `bridges/AGENTS.md` and
`bridges/claude-bridge/AGENTS.md` before starting.

1. **Direct tests first.** Add `session-manager-prompt-stream.test.ts`,
   driving `createPromptStreamState` on a bare session (the `turn-fixture.ts`
   pattern) and asserting emitted `message.updated` frames and
   `session.messages`. Cover at least:
   - one row per API message id, in creation order;
   - deltas for one block collapsing into one part, and the final
     `assistant` record overwriting what streamed;
   - a subagent frame joining the row that holds its call, including after a
     newer root row exists;
   - `refreshToolRows` rebuilding an older row for a late tool result;
   - the 256-row bound and the 128-part subagent bound;
   - a block index above `MAX_STREAM_CONTENT_BLOCK_INDEX` being ignored;
   - flush ordering: a non-delta flush publishes pending rows oldest first,
     and `clearFlushTimer` leaves nothing scheduled;
   - two stream states on one session (a released turn and its successor)
     sharing rows through `sessionStreamRows`;
   - `beginPostSteerScope` publishing everything streamed before a steer, and a
     response that started before the steer's row staying above it (its
     anchor).
2. **Split `applyPartialAssistantMessage`** into one function per
   `stream_event` type, with the shared block lookup (block index, message
   key, parent task id) and `appendStreamedDelta` as their own helpers.
3. **Move the three plan-mode flags to `TurnState`**
   (`session-manager-prompt-turn.ts`) and fix the stale comment.
4. **Optional:** turn the factory into a `PromptStream` class with private
   fields, keeping `PromptStreamState` as its interface. Skip this if steps
   1–3 already leave every function short and the factory readable;
   converting a closure to a class meets the line metric without making the
   code much easier to read.

Done when:

- `createPromptStreamState` (or its replacement) has direct tests for every
  behaviour in step 1;
- no function in `session-manager-prompt-stream.ts` exceeds about 150 lines,
  and no function in any `session-manager-prompt*.ts` exceeds about 300;
- the plan-mode flags live on `TurnState`.

### Qualification

- Run the full claude-bridge suite after every step.

## Constraints and rationale

- Per-token cost. `applyPartialAssistantMessage` and
  `scheduleStreamedAssistantMessageFlush` run once per delta. The split must
  add no allocations, closures or `Date` calls on that path.
- Identity. Rows are compared by identity (`dirtyRows`, `rowOfMessage`,
  `sharedRows`). Nothing may copy rows or rebuild those maps.
- Shared rows. `sessionStreamRows` stays module state keyed by session, looked
  up exactly as the factory does today, including the reset when
  `session.messages` is replaced.
- Timers. `clearFlushTimer` must still run from `finalizeTurn`
  (`session-manager-prompt-settle.ts`), or a finished turn would publish late.
- Coalescing. Deltas land in their row immediately; the rebuild and emit
  happen at most once per `STREAM_EVENT_COALESCE_MS`. Every non-delta frame
  flushes first, and nothing in the frame loop may wait on rendering.

## Related

- `bridges/AGENTS.md` and `bridges/claude-bridge/AGENTS.md` (transcript-row
  rules).
- [`agent-engines.md`](../../architecture/agent-engines.md).

## Replaces

- `docs/2026-10-15/01-claude-bridge-prompt-stream-state.md`
- `docs/2026-10-14/03-claude-bridge-send-prompt-decomposition.md` (only its
  remaining "done when": no function in `session-manager-prompt*.ts` over
  about 300 lines)
