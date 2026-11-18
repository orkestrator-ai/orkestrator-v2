# Group transcript tool calls in one pass

## Task analysis

Analysed 2026-11-18 against `main` at `583da944e`. Benchmark from the performance review at `259e88d90`.

### Tasks

1. Build each contiguous run of tool-only assistant rows in one pass. Status: open.

### 1. Build each contiguous run of tool-only assistant rows in one pass

**Problem.** Opening or paging in a long tool-heavy transcript can stall the renderer. On a cache miss, every additional tool-only row flattens and regroups all the parts accumulated so far, so a fresh run of rows takes quadratic work.

**Context.** `normalizeNativeMessages` calls `coalesceAdjacentToolMessages` before the transcript renders. The grouping depends on the model, turn and plan-review flag. Existing aliases preserve the visible card's ID when history is prepended or live rows extend the run. [Transcript adapters](../../../apps/web/src/lib/chat/native-message-adapters.ts)

**Investigation.** Headless Chromium 159 ran the production grouping function on fresh arrays with one tool call per row and all rows in the same turn. Median time over seven runs per size was 3.0 ms for 128 rows, 10.6 ms for 256, 41 ms for 512 and 161 ms for 1,024. The measurement isolates grouping before React renders.

**Decisions.**

- **Accumulate a run's parts and group them once (recommended).** Pros include linear work on a fresh run and fewer intermediate allocations. Preserving row identity and reuse on unchanged inputs requires care.
- **Keep merging adjacent pairs and rely on the existing cache.** Pros include straightforward reuse when the identical prefix survives. A fresh run or a history prepend can still force repeated work.

## Needs verification

- Repeat the Chromium benchmark across the same sizes with fresh rows. Also measure a live append to a stable run to catch regressions in the existing cache behavior.
- Exercise a history prepend, a live append, and a tab return or reload. Verify tool order, grouping boundaries, source anchors, and stable IDs for retained rows. Confirm an expanded card stays open when its run grows. [Existing adapter tests](../../../apps/web/src/lib/chat/native-message-adapters.test.ts)
