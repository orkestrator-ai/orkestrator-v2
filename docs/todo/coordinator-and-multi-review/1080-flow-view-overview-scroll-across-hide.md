# Build Pipeline and Graph Run overviews may lose their scroll position under WebKit

Multi Review's overview now keeps its scroll position when another tab takes over ([0860](0860-multi-review-inspector-webkit-divergences.md)). Build Pipeline and Graph Run have the same scroller shape and were not changed. Under WebKit they are likely to jump to the top on return to the tab. This comes from reading the code and from an engine-only reproduction; neither view has been run through it.

## Task analysis

Analysed 2026-10-31 against `main` at `931e5541`.

### Tasks

1. **Keep the overview's scroll position in Build Pipeline and Graph Run**: measure the loss under WebKit, then apply `useScrollOffsetAcrossHide`. Status: open.

### 1. Keep the overview's scroll position in Build Pipeline and Graph Run

**Problem.** A reader who scrolled down a Build Pipeline or Graph Run overview may land back at the top after switching to another tab and back, under WebKit.

**Context.** `apps/web/src/components/build-pipeline/PipelineFlowView.tsx` (`pipeline-flow-scroll`) and `apps/web/src/components/graph-run/GraphRunTab.tsx` both hold a `@container` child inside an `overflow-y-auto` scroller. In 0860 an engine-only page lost the offset across `display: none` in that exact shape, in Playwright WebKit and not in Chromium. The `FlowGraph` half of the fix is shared, so both views have already stopped collapsing while hidden. Only the WebKit half is missing.

**Investigation.** Not measured. The Build Pipeline fixture renders its view with `isActive` fixed and Graph Run has no fixture, so no spec can hide either pane yet. The transcripts in those views were not checked either.

**Decisions.**

- **How to fix it?**
  - **Add a pane toggle to the Build Pipeline fixture, add a Graph Run fixture with one, show the loss under WebKit, then call `useScrollOffsetAcrossHide` on each scroller (recommended).**
    - Pros: the same fix as Multi Review, with a test that fails first.
    - Cons: fixture work for a problem that real Safari has not yet confirmed.
  - **Call the hook now without fixtures.**
    - Pros: two small changes; harmless where the browser keeps the offset.
    - Cons: no proof it was needed or that it works.
  - **Wait for 0860 task 4 to confirm real Safari behaves the same.**
    - Pros: no work if real Safari keeps the offset.
    - Cons: needs hardware, and leaves a known WebKit difference in place until then.

## Related

- [0860-multi-review-inspector-webkit-divergences.md](0860-multi-review-inspector-webkit-divergences.md): the cause, the engine-only reproduction and the hook.
