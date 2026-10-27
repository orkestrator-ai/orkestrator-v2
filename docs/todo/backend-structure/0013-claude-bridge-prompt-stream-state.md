# Claude bridge prompt stream state

Checked against `main` at `2459b05c` (2026-10-15). Done on
`todo-0013-claude-prompt-stream-state-00f9c30bd403` from `ba7cc8d4` (2026-10-25).
Every item below is done. The durable rules now live in
[`bridges/claude-bridge/AGENTS.md`](../../../bridges/claude-bridge/AGENTS.md)
("One row per model response"); delete this file and its index row once the
branch has merged.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Retire this finished file**: the direct tests, the delta-handler split, the plan-mode flags on `TurnState` and the `PromptStream` class are done and merged (#1241); only the file's own retirement remains. Status: done.

### 1. Retire this finished file

**Problem.** The file is marked Finished and says to delete it with its index row once the branch merged. It still holds rank 9 in the folder index, and another todo still plans around it as if it were open.

**Context.** The README rule: move durable behaviour into `architecture/` (here, the bridge's `AGENTS.md`), delete the file, remove the row.

**Investigation.** The branch merged as `ad024ea8` (#1241). The claims hold at HEAD: `createPromptStreamState` is a factory (`bridges/claude-bridge/src/services/session-manager-prompt-stream.ts:184`) returning `class PromptStream` (`:209`); the bounds are unchanged (`MAX_STREAM_CONTENT_BLOCK_INDEX` `:72`, `MAX_TRACKED_STREAM_ROWS` `:83`, `MAX_SUBAGENT_PARTS_PER_CALL` `:94`); `sessionStreamRows` is still the module `WeakMap` (`:154`, looked up at `:265`); the plan-mode flags are on `TurnState` (`session-manager-prompt-turn.ts:185`, `:210`). The longest methods in the stream module are about 70 to 80 lines (`createRow`, a pending-chunks branch), within the file's "about 150 lines" target. `session-manager-prompt-stream.test.ts` has 15 `test(` calls (the file says 16, likely counting a parameterised case). Neither stream file has changed since the merge; seven later commits touched other `session-manager-prompt*.ts` files. The durable rules are in `bridges/claude-bridge/AGENTS.md` "One row per model response" (from line 93): one row per API message id, `refreshToolRows`, the allocation-free delta path, identity comparison, shared rows through `sessionStreamRows`, coalescing and `clearFlushTimer`, and turn flags on `TurnState`. That covers every item under "Constraints and rationale". Stale elsewhere: [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md) still has a decision "Order relative to 0013?" recommending its work go first, and links here from its Related section; both need updating when this file goes.

**Decisions.**

- **What to do with this file now that its branch has merged?**
  - **Delete it now, and update 0005's link and ordering decision in the same change (recommended).**
    - Pros: follows the README rule; every durable rule is already in the bridge `AGENTS.md`, which Claude Code loads when editing those files; removes a misleading ordering question from 0005.
    - Cons: decisions 3 (reused lookup target) and 5 (successor adopts a shared row by API message id only) survive only in git history; 3 is summarised in `AGENTS.md`, and 5 is pinned only by the handoff test in `session-manager-prompt-stream.test.ts`.
  - **Delete it after adding decision 5 to `bridges/claude-bridge/AGENTS.md`.**
    - Pros: keeps the one row-sharing rule not yet written down beside the other row rules.
    - Cons: edits a bridge `AGENTS.md`, which then needs the normal review that file's area rules ask for.
  - **Keep it until 0005 is done.**
    - Pros: 0005 keeps a working link.
    - Cons: contradicts the README rule, and 0005's ordering decision stays wrong.

`createPromptStreamState` in the Claude bridge turns the SDK's streamed
frames into transcript rows. It carries the bridge's transcript-row rules (one
row per model response, late updates finding their row, bounded state, rows
shared across a turn handoff), yet it was tested only indirectly through
`sendPrompt`. It was also the one function left in `session-manager-prompt*.ts`
over the 300-line cap set when `sendPrompt` was broken up in #984. The work was
to give it direct tests first, then split its per-token delta handler and move
turn concerns out of it.

## Current state

As of this branch:

- `createPromptStreamState` in
  `bridges/claude-bridge/src/services/session-manager-prompt-stream.ts` is a
  four-line factory returning a `PromptStream` class (private fields, typed by
  the unchanged `PromptStreamState` interface). The longest method is `emitRow`
  at 54 lines; the old factory was 631 lines.
- `applyPartialAssistantMessage` is a dispatcher over `applyMessageStart`,
  `applyMessageStop`, `applyContentBlockStart` and `applyContentBlockDelta`.
  The shared block lookup (block index, message key, parent task id, row,
  blocks) is `locateStreamBlock`; `appendStreamedDelta` and
  `storeStreamedEntry` are their own methods.
- The plan-mode flags `pendingPlanRejectionFeedback`, `planApprovedThisTurn`
  and `pendingPlanApprovalContinuation` are on `TurnState`
  (`session-manager-prompt-turn.ts`), initialized in `createTurnState`. Their
  comment now points at `resolveQueryPlan` (`session-manager-prompt-query.ts`),
  where `permissionMode: "plan"` is forwarded.
- `session-manager-prompt-stream.test.ts` drives the stream directly on a bare
  session (16 tests).
- `turnCanUseTool` had grown to 327 lines since this file was written (it said
  251). AskUserQuestion, EnterPlanMode and ExitPlanMode moved verbatim into
  `askUserQuestion`, `enterPlanMode` and `requestPlanApproval`.
- Longest functions now in `session-manager-prompt*.ts` and
  `session-manager-prompt-handlers/` (non-test): `handleResultMessage` 254,
  `runMcpCallProbe` (live probe) 242, `claudeQueryOptions` 223,
  `resolveQueryPlan` 168, `requestPlanApproval` 158.
- Bounds and constants are unchanged: `MAX_STREAM_CONTENT_BLOCK_INDEX`
  (4,095), `MAX_TRACKED_STREAM_ROWS` (256), `MAX_SUBAGENT_PARTS_PER_CALL`
  (128) in the stream module; `STREAM_EVENT_COALESCE_MS` (100) in
  `session-manager-prompt-admission.ts`. `sessionStreamRows` is still a
  module-level `WeakMap` keyed by session and looked up in the constructor
  exactly as the factory did.

## Outstanding work

### Code

All four steps are done: step 1 has its own test commit, and steps 2–4 share
the refactor commit (decision 1).

1. **Done — direct tests** (`26bcee502`).
   `session-manager-prompt-stream.test.ts` drives `createPromptStreamState` on
   a bare session (the `turn-fixture.ts` pattern) and asserts emitted
   `message.updated` / `message.patched` frames and `session.messages`. It
   was written and passing against the unchanged closure before any refactor.
   Coverage, one test each unless noted:
   - one row per API message id, in creation order;
   - deltas for one block (thinking and text) collapsing into one part each,
     nothing published before a flush, and the final per-block `assistant`
     records overwriting what streamed;
   - a subagent frame (streamed and finalized) joining the row that holds its
     call after a newer root row exists, with the parent noted in
     `revisedRows`;
   - `refreshToolRows` rebuilding an older row for a late tool result, only
     the changed row publishing a frame;
   - the 256-row bound (forgotten row stays in the transcript; a late frame for
     its call lands on the current row) and the 128-part subagent bound;
   - block indices above `maxBlockIndex`, negative, fractional, string and
     missing being ignored, and the bound itself accepted; plus a test that
     unrendered events (`tool_use` start, `input_json_delta`,
     `content_block_stop`, `message_stop`) publish nothing;
   - flush ordering: a non-delta frame publishes pending rows oldest first
     although the newer row turned dirty first; the timer publishes coalesced
     deltas once, and `clearFlushTimer` leaves nothing scheduled;
   - two stream states on one session sharing a row through
     `sessionStreamRows` (block count included), and a replaced
     `session.messages` not adopting old rows;
   - `beginPostSteerScope` publishing everything streamed before a steer, and a
     response that started before the steer's row staying above it.

   Mutation check: removing the flush sort, the block-index bound, the subagent
   shed, the row anchor or the shared-row lookup each fails exactly the test
   aimed at it.

   Review follow-up: two more tests assert that `content_block_stop` and a
   future unrendered block event bind their message to its row before a newer
   response starts, so late content still reaches the original row. Removing
   the default branch's `locateStreamBlock` call fails both tests.
2. **Done — `applyPartialAssistantMessage` split** (`3128367a4`), one method
   per `stream_event` type plus `locateStreamBlock` and `appendStreamedDelta`.
   Event order and side effects are kept: `content_block_stop` and other block
   events still route their message to a row before being ignored.
3. **Done — plan-mode flags on `TurnState`** (`3128367a4`), stale comment
   fixed; callers in `session-manager-prompt-can-use-tool.ts`,
   `session-manager-prompt-settle.ts` and the `user` and `assistant` handlers
   read `turn.*`.
4. **Done — `PromptStream` class** (`3128367a4`). Not optional in the end:
   after steps 2–3 the factory would still have been about 470 lines, over the
   150-line bar below (decision 2).

Also done, for the second "done when" bullet: **`turnCanUseTool` split**
(`482283d4d`), decision 4.

Done when, checked on the branch:

- `createPromptStreamState` (now `PromptStream`) has direct tests for every
  behaviour in step 1 — done;
- no function in `session-manager-prompt-stream.ts` exceeds about 150 lines
  (longest 54), and no function in any `session-manager-prompt*.ts` exceeds
  about 300 (longest 254) — done, measured with an oxc-parser walk of every
  function, method and arrow;
- the plan-mode flags live on `TurnState` — done.

### Qualification

Done. The full claude-bridge suite
(`bun run --cwd bridges/claude-bridge test:bridge`) ran after each commit: with
the new tests on the unchanged stream, after the stream refactor and after the
`turnCanUseTool` split. Each run: 1,633 pass, 5 skip, 0 fail. The bridge
typecheck (`bun run --cwd bridges/claude-bridge typecheck`) is clean, `bun fmt`
changed only files on this branch, and `oxlint` reports nothing in the touched
files.

## Assumptions and decisions

1. **One branch, direct tests first, then a shared refactor commit** instead of
   one PR per step. Options: four PRs, or one branch with separate test and
   refactor commits. Chosen: one branch, because the
   coordinator delegated the whole file as one unit. Steps 2–4 share a commit:
   splitting the closure first and then converting it to a class would have
   rewritten the same lines twice, and step 3 removes members from the same
   interface. Pros: one review of the finished structure; the tests commit
   still lands first and proves the refactor against the old code. Cons: the
   refactor commit is a near-total rewrite of one file, so its diff reads worse
   than a pure move would.
2. **Do step 4 (class), though marked optional.** Options: stop after steps
   2–3 and leave a ~470-line factory, hoist the closures into module functions
   over a shared state record, or convert to a class. Chosen: a class. The
   "done when" bar (no function over ~150 lines) cannot be met by a closure
   factory, and module functions over a state record are a class written by
   hand. Pros: every method is short; private fields make the state explicit;
   `PromptStreamState` and `createPromptStreamState` are unchanged, so no
   caller moved. Cons: `this.` noise throughout; `spyOn(stream, …)` now also
   intercepts the stream's internal calls (harmless today, since the only
   spy is in `settleFailedTurn`, which makes none).
3. **A reused lookup target instead of a returned object.** The per-token
   constraint forbids new allocations on the delta path, but the lookup yields
   five values. Options: an object literal per event, five private scratch
   fields, or one `StreamBlockTarget` per stream refilled on every event.
   Chosen: the reused target. Pros: no allocation per event; handlers take one
   typed argument. Cons: the target is only valid until the next event, so it
   must never be retained (nothing does). As a side effect the delta path now
   allocates less than before: the per-event `appendStreamedDelta` closure is
   gone, and the flush timer callback is created once per stream rather than
   once per scheduled flush.
4. **Split `turnCanUseTool` here, though the file did not list it.** It had
   grown past 300 lines since the file was written, so the second "done when"
   bullet failed on `main`. Options: record it as a new todo, or move its
   three tool branches into functions. Chosen: move them verbatim; the
   dispatch and every message are unchanged. Pros: the done-when holds; the
   policy decision for ordinary tools is now visible at a glance. Cons: a
   change outside the stream module, in code the existing `sendPrompt` tests
   cover only through the full turn.
5. **The successor turn adopts a shared row by API message id only.** While
   writing the handoff test, the first draft expected a successor's subagent
   frame to find an earlier turn's call before any record named that call's
   response. It does not: rows are adopted in `createRow` when a record or
   `message_start` names the same API message, and a subagent's frames reach
   the turn holding its call through `routeClaudeFrame`. The test pins the
   real behaviour (adoption, block count carried over, then subagent routing).
   No code changed.
6. **Kept as-is.** `pendingApiRetryMessageId` stays on `PromptStreamState`:
   the file asked only for the plan-mode flags, and `settlePendingApiRetry`
   takes the stream as its argument. Moving it is a separate, optional
   cleanup.

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
