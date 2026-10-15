# 01 — Claude bridge: test, then split, `createPromptStreamState`

Status: Proposed (2026-10-15). Follow-up to
[03 — `sendPrompt` decomposition](../2026-10-14/03-claude-bridge-send-prompt-decomposition.md),
whose "done when" asks that no function in `session-manager-prompt*.ts` exceed
about 300 lines. This is the one function still over. Read
[`bridges/AGENTS.md`](../../bridges/AGENTS.md) and
[`bridges/claude-bridge/AGENTS.md`](../../bridges/claude-bridge/AGENTS.md)
before starting.

## Problem

`createPromptStreamState` in
`bridges/claude-bridge/src/services/session-manager-prompt-stream.ts` runs from
line 158 to 788 (about 630 lines). Unlike the old `sendPrompt`, it is not a mix
of unrelated phases. It is a class written as a factory: roughly ten private
`let`s and maps, about twenty short closures over them, and a returned object
behind the typed `PromptStreamState` interface.

| Lines | Part |
| --- | --- |
| 173–217 | Private state: flush timer, rows, row indexes, current row, sequence, current streamed API message id, dirty rows |
| 219–365 | Row bookkeeping: `forgetRow`, `createRow`, `rowForApiMessage`, `getBlocks`, `materializeEntryValue`, `rebuildOrderedParts` |
| 367–402 | `activeTaskIds` and the three plan-mode flags |
| 411–528 | Publishing: `emitRow`, `newestRowMessage`, `insertAfterAnchor`, `materializeRow` |
| 530–548 | Delta coalescing: `flushStreamedAssistantMessage`, `scheduleStreamedAssistantMessageFlush` |
| 549–603 | `applyAssistantRecord`, `refreshToolRows` |
| 604–736 | `applyPartialAssistantMessage` (about 134 lines), one branch per `stream_event` type |
| 738–787 | The returned `PromptStreamState` object |

So the line count mostly measures a class body. Converting it to a class
would meet the metric without making it much easier to read. The parts that
would genuinely help are smaller:

- `applyPartialAssistantMessage` is the only long method. It handles
  `message_start`, `message_stop`, `content_block_start` and
  `content_block_delta` in one body, with a nested `appendStreamedDelta`
  closure.
- `pendingPlanRejectionFeedback`, `planApprovedThisTurn` and
  `pendingPlanApprovalContinuation` live in the stream state, but are turn
  concerns. Only `turnCanUseTool`, the `user` and `assistant` handlers and
  `settleTurnEnd` read or write them. They belong on `TurnState`. The comment
  above them also points at "the permissionMode site above", which now lives in
  `session-manager-prompt-query.ts`.
- `MAX_STREAM_CONTENT_BLOCK_INDEX` is defined twice, in
  `session-manager-prompt-stream.ts` and `session-manager-prompt-admission.ts`
  (re-exported from `session-manager-prompt.ts`). The values agree today;
  nothing enforces that.

## Why this is risky

This code carries the transcript-row rules in `bridges/AGENTS.md` and
`bridges/claude-bridge/AGENTS.md`:

- **One row per model response.** A root response opens a row keyed by its API
  message id. A subagent's output joins the row holding the call that started
  it.
- **Late updates find their row.** A tool result, denial or command change
  rebuilds the row holding the call (`refreshToolRows`), however old it is.
- **Bounded state.** `MAX_TRACKED_STREAM_ROWS` (256) and
  `MAX_SUBAGENT_PARTS_PER_CALL` (128) keep a turn that lives for hours small.
- **Rows shared across turns.** `sessionStreamRows` (a `WeakMap` per session)
  lets a released turn and its successor agree on API message identity.
- **Coalescing.** Deltas land in their row immediately; the rebuild and emit
  happen at most once per `STREAM_EVENT_COALESCE_MS`. Every non-delta frame
  flushes first, and nothing in the frame loop may wait on rendering.

It also changed recently, in #971. Nothing calls `createPromptStreamState`
directly in a test: it is covered only through `sendPrompt`
(`session-manager-prompt.test.ts`, `session-manager-transcript-revision.test.ts`,
`session-manager-catalog-steer.test.ts` and others). That is thin protection for
a structural change to row bookkeeping.

## Order

Each step is one PR and keeps behaviour identical.

1. **Direct tests first.** Add `session-manager-prompt-stream.test.ts`, driving
   `createPromptStreamState` on a bare session (the
   `session-manager-prompt-handlers/turn-fixture.ts` pattern) and asserting
   emitted `message.updated` frames and `session.messages`. Cover at least:
   - one row per API message id, in creation order;
   - deltas for one block collapsing into one part, and the final
     `assistant` record overwriting what streamed;
   - a subagent frame joining the row holding its call, including after a
     newer root row exists;
   - `refreshToolRows` rebuilding an older row for a late tool result;
   - the 256-row bound and the 128-part subagent bound;
   - a block index above `MAX_STREAM_CONTENT_BLOCK_INDEX` being ignored;
   - flush ordering: a non-delta flush publishes pending rows oldest first,
     and `clearFlushTimer` leaves nothing scheduled;
   - two stream states on one session (a released turn and its successor)
     sharing rows through `sessionStreamRows`;
   - `beginPostSteerScope` publishing everything streamed before a steer, and
     a response that started before the steer's row staying above it (its
     `anchor`).
2. **Split `applyPartialAssistantMessage`** into one function per event type,
   with the shared block lookup (`blockIndex`, `messageKey`, parent task id)
   and `appendStreamedDelta` as their own helpers. It runs once per token, so
   allocate no more per call than it does today.
3. **Move the plan-mode flags to `TurnState`** and fix the stale comment. Keep
   one definition of `MAX_STREAM_CONTENT_BLOCK_INDEX` (in the stream module)
   and re-export it.
4. **Only if it still reads better:** turn the factory into a `PromptStream`
   class with private fields, keeping `PromptStreamState` as its interface.
   Skip this step if steps 1–3 already leave every method short and the
   factory readable.

## Risks

- **Per-token cost.** `applyPartialAssistantMessage` and
  `scheduleStreamedAssistantMessageFlush` run for every delta. Splitting must
  not add allocations, closures or `Date` calls on that path.
- **Identity.** Rows are compared by identity (`dirtyRows`, `rowOfMessage`,
  `sharedRows`). A class conversion must not copy rows or rebuild the maps.
- **Shared rows.** `sessionStreamRows` is module state keyed by session. It
  stays where it is; a class must look it up exactly as the factory does,
  including resetting when `session.messages` is replaced.
- **Timers.** The coalescing timer must still be cleared by
  `clearFlushTimer` from `finalizeTurn`, or a finished turn would publish late.

## Done when

- `createPromptStreamState` (or its replacement) has direct tests for the
  behaviours listed in step 1.
- No function in `session-manager-prompt-stream.ts` exceeds about 150 lines.
- The plan-mode flags live on `TurnState`, and
  `MAX_STREAM_CONTENT_BLOCK_INDEX` has one definition.
