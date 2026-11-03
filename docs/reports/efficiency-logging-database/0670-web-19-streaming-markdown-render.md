# Streaming markdown rebuilds the whole message's tree per update

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Reuse settled blocks while streaming**: stop rebuilding React and HAST for the finished part of a message. Status: open.

### 1. Reuse settled blocks while streaming

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

## Constraints and rationale

The final, non-live render always parses in full (`MessageMarkdown.tsx:360-362`), and that must stay.

## Needs verification

- The real cost; no Profiler run has been made.

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3
