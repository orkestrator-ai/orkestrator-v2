# E22: Chat rendering

This file combines 2 reports into one batch to build together. Both redo work on each transcript update.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0600](#0600-with-find-open-the-whole-transcript-is-re-indexed-on-every-update) | Low | WEB-10: With find open, the whole transcript is re-indexed on every update |
| [0670](#0670-streaming-markdown-rebuilds-the-whole-messages-tree-per-update) | Low | WEB-19: Streaming markdown rebuilds the whole message's tree per update |

## 0600: With find open, the whole transcript is re-indexed on every update

### Task analysis

#### Tasks

1. **Index per message object**: reuse a message's search text until the message changes. Status: done (2026-11-04; [1202 task 3](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)), with a per-hook index that compares content rather than the WeakMap recommended below, because a reparsed row is a new object.

#### 1. Index per message object

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

### Constraints and rationale

Search projections hold message text, so a new cache must be cleared with the protected rich caches (`registerProtectedRichCache`, `markdown-search.ts`). A WeakMap held elsewhere must not outlive that clear.

### Needs verification

- Answered 2026-11-04: `normalizeNativeMessages` keeps a plain row's identity only when it re-normalises the same raw copy; a reparsed copy has new objects, so the WeakMap would miss on it.

## 0670: Streaming markdown rebuilds the whole message's tree per update

### Task analysis

#### Tasks

1. **Reuse settled blocks while streaming**: stop rebuilding React and HAST for the finished part of a message. Status: open.

#### 1. Reuse settled blocks while streaming

**Problem.** The syntax tree is parsed incrementally, but each update still converts and renders the whole message.

**Context.** The report rates this Low, with Medium confidence, and names no fix.

**Investigation.** `apps/web/src/components/chat/MessageMarkdown.tsx:363-369` reuses the completed prefix's syntax tree through `IncrementalMarkdownCache` (`apps/web/src/lib/chat/rich-markdown/incremental-parse.ts:134`, `:207`). The output still goes through a single `Markdown` element (`MessageMarkdown.tsx:393-399`), which takes the whole source each time.

**Decisions.**

- **Worth doing?**
  - **Leave it until a Profiler run on a long streaming message shows this as the cost (recommended).**
    - Pros: no risk to markdown that spans blocks; the parse, the larger cost, is already incremental.
    - Cons: long messages keep the cost until then.
  - **Render each settled top-level block as its own memoised element.**
    - Pros: only the tail re-renders.
    - Cons: replaces `react-markdown`'s single pass, and rich find and copy rely on the structure it produces.

### Constraints and rationale

The final, non-live render always parses in full (`MessageMarkdown.tsx:360-362`), and that must stay.

### Needs verification

- The real cost; no Profiler run has been made.

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3
