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
- 1202 recommended doing the replay ring work (E-0360) after this; it was done 2026-11-05.

## Needs verification

- Who still consumes full `message.patched` frames. The bridge's own tests and any non-observe subscriber were not traced.

## Related

- [Efficiency report, C](../2026-10-27-efficiency.md#c-bridges) (BR-7)
- [1202 task 6](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
