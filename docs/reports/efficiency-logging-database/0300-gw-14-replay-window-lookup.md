# Replay lookup is a linear filter and an oversized event is invisible

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Find the replay range by index**: replace the filter with a slice. Status: open.
2. **Count oversized appends**: add a metric for an event that empties the window. Status: open.

### 1. Find the replay range by index

**Problem.** Each replay filters the whole window, though the range can be computed.

**Context.** Revisions are contiguous: `append` adds one per frame, and frames leave only from the front.

**Investigation.** `this.frames.filter((frame) => frame.revision > revision)` is at `apps/backend/src/gateway-event-replay.ts:162`. `oldestRevision` is `frames[0]?.revision` (`:110-111`). The `complete` check above it has already proved the range is held. The window is at most 2,048 frames (`:9`).

**Decisions.** None: `slice(revision + 1 - oldest)` is the report's fix and returns the same frames.

### 2. Count oversized appends

**Problem.** One event larger than the byte limit evicts everything, including itself, and every reconnecting client then reconciles. Nothing reports that this happened.

**Context.** The eviction loop treats the new frame like any other. Only `droppedFrames` is counted (`:90`), which cannot tell this case from normal turnover.

**Investigation.** The loop is at `gateway-event-replay.ts:131-136`. After it the window is empty, `oldestRevision` is 0, and `since` answers incomplete (`:159`), so the cursor expires and the client reconciles.

**Decisions.** None: the report asks only for the metric. Keeping older frames across an event that cannot be retained would make that gap undetectable.

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): missed events stay detectable, and metrics stay content-free. Count the event, and do not label it with payload data.

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-14)
- [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
