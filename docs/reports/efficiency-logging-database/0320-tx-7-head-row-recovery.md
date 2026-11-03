# Head-row recovery re-reads the raw transcript on each streaming revision

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Stop recovering on every revision**: wait for the source token to settle, or read only the head row. Status: open.

### 1. Stop recovering on every revision

**Problem.** While a part-trimmed head row is in the window, each new source token cancels the pending recovery and starts another, each one reading raw messages from the provider and discarding what it read if the token has moved on.

**Context.** The trigger is narrower than the report implies. A summary window with no omitted parts returns early, so this needs a part-trimmed head (one row larger than the whole window) or a cached summary.

**Investigation.** `scheduleIncompleteProgressiveHydration` (`apps/backend/src/core/native-agent-transcript-projection.ts:1888`) first fences stale work with `invalidateStaleProgressiveHydration` (`:1901`, `:2009`). The early return is at `:1924-1929`. The first attempt has no delay (`scheduleAttempt(0)`, `:2006`). The read is `provider.messages(sessionId, { limit })` (`:2026`), bounded in rows but not to the byte window. A result is dropped when the source token has moved (`:1963`). Retries back off (`:1972`), but only for a read that recovered nothing.

**Decisions.**

- **How to reduce the reads?**
  - **Debounce: start the read only once the source token has stayed the same for a short interval (recommended).**
    - Pros: the report's first fix; no new provider call; the existing `holdPreview` keeps the view stable meanwhile.
    - Cons: the head stays trimmed until the turn pauses, so a long streaming turn may show it trimmed for longer. The interval needs a choice.
  - **Read just the head row through a page or detail read.**
    - Pros: the report's preferred read; bounded bytes; works during streaming.
    - Cons: needs the provider's page capability, so this path remains for providers without it; a larger change.

## Constraints and rationale

- A cached summary must still recover, because this read is the only thing that attaches a detached Codex thread (see the comment at `native-agent-transcript-projection.ts:1910-1914`). A debounce must not starve that case.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): unmount is not cancel.

## Needs verification

- How often sessions have a part-trimmed head during streaming. Reasoned, not measured.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-7)
- [1202 task 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
