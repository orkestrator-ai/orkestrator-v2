# With find open, the whole transcript is re-indexed on every update

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Index per message object**: reuse a message's search text until the message changes. Status: open.

### 1. Index per message object

**Problem.** While find is open, each transcript update maps every item through `getSearchText`, and a long transcript can thrash the 512-entry cache.

**Context.** This costs nothing while find is closed. The report suggests a per-message WeakMap, not caching parts that are still streaming, and a debounce.

**Investigation.** `apps/web/src/components/chat/AgentChatFind.tsx:110-118` recomputes on any change to `items`, and only while find has a query. The cache is keyed by the text itself and bounded at 512 entries and 8 MiB (`apps/web/src/lib/chat/rich-markdown/markdown-search.ts:256-257`, `:267-287`), so a transcript with more text parts than that evicts its own entries in each pass. Native search text comes from `getNativeMessageSearchProjection` (`apps/web/src/components/chat/native-message-search.ts:270`).

**Decisions.**

- **Cache by object, or only debounce?**
  - **A WeakMap from message object to search projection, in front of the existing cache (recommended).**
    - Pros: an unchanged message costs one lookup; a weak key needs no eviction; the text cache keeps its role for new objects.
    - Cons: helps only if unchanged rows keep their identity through normalisation.
  - **Debounce the recomputation.**
    - Pros: trivial.
    - Cons: every pass still re-indexes everything, and match results lag behind the text.

## Constraints and rationale

Search projections hold message text, so a new cache must be cleared with the protected rich caches (`registerProtectedRichCache`, `markdown-search.ts`). A WeakMap held elsewhere must not outlive that clear.

## Needs verification

- Whether normalised rows keep their identity across updates. I did not trace it through `normalizeNativeMessages`, and it decides whether the WeakMap helps.

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3
