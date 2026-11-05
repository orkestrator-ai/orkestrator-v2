# Codex re-renders and re-sends running tool cards every publish tick

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Cache in-progress item parts by accumulator version**: re-render a running item only when it changed. Status: done 2026-11-04 ([1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 6).
2. **Send `content` only when it changed**: stop duplicating it into every `message.patched`. Status: done 2026-11-04 ([1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 6).

### 1. Cache in-progress item parts by accumulator version

**Problem.** Each publish tick rebuilds the parts of every running item, and because they are new objects they are all listed as changed.

**Context.** Completed items are already cached and reused by identity. The publish cadence starts at 100 ms (`bridges/codex-bridge/src/app-server-runtime-base.ts:285-289`).

**Investigation.** In `bridges/codex-bridge/src/messages/render-turn.ts`, the cache check at `:859` and `:867-872` applies only when `accumulator?.completed`. Otherwise `itemToParts` runs (`:875`) and `completedItemParts` is cleared. `isSamePublishedPart` (`app-server-runtime-base.ts:296-304`) treats any non-text part as changed unless it is the same object, so `app-server-runtime-rows.ts:462` lists every running card. `accumulator.version` exists and already keys a machine-output cache (`render-turn.ts:73`, `:195`).

**Decisions.**

- **What keys the cache?**
  - **`accumulator.version` plus `commandChanges`, as the completed cache checks its source and changes (recommended).**
    - Pros: the report's fix; unchanged running cards keep their identity, which the publish diff already rewards.
    - Cons: every change that affects rendering must move the version, including the progress line and any stamp.
  - **Compare rendered parts by content in `isSamePublishedPart`.**
    - Pros: no version audit.
    - Cons: still renders each card, then adds a deep compare per tick.

### 2. Send `content` only when it changed

**Problem.** `content` is copied into every patch, even when only a tool part moved.

**Context.** The report rates the wire cost low: the backend subscribes only to the content-free `?observe=1` stream.

**Investigation.** The patch is built at `app-server-runtime-rows.ts:473-481`, with `content: message.content` at `:477`, as `satisfies MessagePatchEventData`. `row.publishedParts` already holds the last parts; no last-content field exists yet.

**Decisions.**

- **Change the wire shape?**
  - **Make `content` optional, and omit it when unchanged (recommended).**
    - Pros: the report's fix; smaller frames for any full subscriber.
    - Cons: every consumer of `message.patched` must treat "absent" as "unchanged", so it needs a check of those readers.
  - **Leave it.**
    - Pros: no contract change for a low wire cost.
    - Cons: frames keep the duplicate.

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): Codex's stdout loop never awaits consumers. This runs on the publish tick, and must stay there.
- 1202 recommends doing the replay ring work ([0360](0360-br-15-sse-replay-rings.md)) after this.

## Needs verification

- Who still consumes full `message.patched` frames. The bridge's own tests and any non-observe subscriber were not traced.

## Related

- [Efficiency report, C](../2026-10-27-efficiency.md#c-bridges) (BR-7)
- [1202 task 6](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)

## Outcome

Checked back against the code on 2026-11-05 at `main` `69a3b4ca5`, before this file was deleted. The tests named were run on that commit and pass.

| Task | Outcome | Code, evidence or to-do |
| --- | --- | --- |
| 1. Cache in-progress item parts by accumulator version | Done | `TurnRenderState.runningItemParts` in `bridges/codex-bridge/src/messages/render-turn.ts` keeps a running item's parts while its accumulator `version` stands still. Keyed on the version alone, because every mutator moves it (1202, "Task 6: BR-7, BR-10, BR-12 to BR-14 and BR-16"). Tests in `messages/render-turn.test.ts`, "running items across publish ticks": `an item that did not change keeps its part objects, progress line included`; `only the item that moved gets new parts`; `a delta landing while a render is awaited is not cached away`; `a kept state renders exactly what a fresh one does`. |
| 2. Send `content` only when it changed | Done | `MessagePatchEventData.content` is optional (`messages/types.ts`), and `app-server-runtime-rows.ts` sends it only when `publishedContent` changed. Tests in `app-server-runtime-rows.test.ts`, "publishing running tool cards": `a patch lists only the card that moved and omits an unchanged body`; `a client applying the frames holds exactly the transcript's row`; `a publish with nothing new sends nothing and moves no revision`; `a new row's first patch carries the body`. |
| Constraint: the stdout loop never awaits consumers | Done | The cache runs on the publish tick in the coalescer, not in the read loop. |
| Needs verification: who still consumes full `message.patched` frames | Done | A search on 2026-11-05 finds Codex's `message.patched` only in `bridges/codex-bridge` (published by `index.ts` and its own tests); nothing in `apps`, `packages` or `e2e` reads it, and the backend subscribes to the content-free `?observe=1` stream. The bridge's own reader is covered by `a client applying the frames holds exactly the transcript's row`. |
