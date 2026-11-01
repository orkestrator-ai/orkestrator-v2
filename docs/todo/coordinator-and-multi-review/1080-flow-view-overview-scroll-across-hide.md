# Build Pipeline and Graph Run overviews may lose their scroll position under WebKit

Multi Review's overview keeps its scroll position when another tab takes over ([0860](0860-multi-review-inspector-webkit-divergences.md)). Build Pipeline and Graph Run have the same scroller shape. Under Playwright WebKit both overviews went back to the top when their tab was hidden and shown again, in the phone and the desktop layout. Fixed 2026-11-01 with the same hook. The transcripts in their inspectors are still to check.

## Task analysis

Analysed 2026-10-31 against `main` at `931e5541`.

### Tasks

1. **Keep the overview's scroll position in Build Pipeline and Graph Run**: measure the loss under WebKit, then apply `useScrollOffsetAcrossHide`. Status: done (2026-11-01). Shown in both views under WebKit and fixed.
2. **Check the inspector transcripts across a hide under WebKit**: Build Pipeline's and Graph Run's transcripts in the inspector. Status: open.

### 1. Keep the overview's scroll position in Build Pipeline and Graph Run

**Problem.** A reader who scrolled down a Build Pipeline or Graph Run overview may land back at the top after switching to another tab and back, under WebKit.

**Context.** `apps/web/src/components/build-pipeline/PipelineFlowView.tsx` (`pipeline-flow-scroll`) and `apps/web/src/components/graph-run/GraphRunTab.tsx` both hold a `@container` child inside an `overflow-y-auto` scroller. In 0860 an engine-only page lost the offset across `display: none` in that exact shape, in Playwright WebKit and not in Chromium. The `FlowGraph` half of the fix is shared, so both views have already stopped collapsing while hidden. Only the WebKit half is missing.

**Investigation.** Measured 2026-11-01 and the loss is real in Playwright WebKit (build 2370, Playwright 1.64). It was checked again on current `main` at `93b99bfb` first. One thing had changed since this file was written: #1487 had already given Graph Run a fixture (`/graph-run-flow`) with a pane toggle. Only Build Pipeline needed one. `/pipeline-flow?paneControls` now wraps `BuildChatTab` in a `hidden` div and passes `isActive`, as the Graph Run fixture does. Graph Run's scroller had no test id, so it got `graph-run-overview-scroll`.

Each spec scrolls the overview to half its range, hides the pane, shows it again and reads `scrollTop`. The viewport is 560 px tall: at the desktop project's 900 px the wide layout overflowed by 0 to 83 px, too little to measure. Before the fix:

| Overview | Layout | Chromium after show | WebKit after show |
| --- | --- | --- | --- |
| Build Pipeline (`fanout`) | Phone, 390 px | kept | 0, was 711 |
| Build Pipeline (`fanout`) | Desktop, 1024 px | kept | 0, was 211 |
| Graph Run | Phone, 390 px | kept | 0, was 610 |
| Graph Run | Desktop, 1024 px | kept | 0, was 117 |

After the fix, all of `PipelineFlow.spec.ts` and `GraphRunFlow.spec.ts` passes in both engines (64 cases each).

The inspector transcripts were not measured. Both use `VirtualizedMessageList`, so they work differently from these scrollers. The fixtures give every session one message, so neither transcript can scroll yet. That is task 2.

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

### 2. Check the inspector transcripts across a hide under WebKit

**Problem.** A reader who scrolled up in a Build Pipeline or Graph Run transcript might land somewhere else after a pane switch under WebKit, as Multi Review's tail did in 0860 task 1.

**Context.** `PipelineSessionTranscript` and `GraphActivationTranscript` (inside a `@container` box) both render `VirtualizedMessageList`, which is Virtuoso and is shared with every native chat tab. Task 1's hook keeps a plain scroller's offset. Virtuoso keeps its own scroll state, so the hook may not fit there.

**Investigation.** Not run. The Build Pipeline fixture gives every session one message, and Graph Run's fixture run has no transcript long enough to scroll.

**Decisions.**

- **How to check it?**
  - **Give one session in each fixture a long transcript, then reuse task 1's hide-and-show spec on the transcript's scroller under WebKit (recommended).**
    - Pros: the same method as task 1; settles whether there is a problem before any code changes.
    - Cons: more fixture data; Virtuoso's own restore may need a different assertion than `scrollTop`.
  - **Check a native chat tab under WebKit first, since it uses the same list.**
    - Pros: one check may cover all three views.
    - Cons: the inspector wraps the list differently, so a pass there would not settle these two.

## Assumptions and decisions

### Task 1: the Graph Run fixture already existed

The file said Graph Run had no fixture. #1487 had added `/graph-run-flow` with a pane toggle before this work started, so only its overview scroller needed a test id. The recommended option was followed in all other respects.

### Task 1: a small scroller component in each view, not the hook on the view itself

Both views return `null` before the scroller when nothing is selected. If the hook were called in the view, it would run its layout effect with no element and never attach. A small `OverviewScroll` component in each file mounts with the scroller, as Multi Review's does. The two copies are left local, like Multi Review's, because their classes differ from Multi Review's, and a shared component would add a class prop for three ten-line uses.

### Task 1: a shorter viewport in the specs

The desktop project's 900 px viewport left the wide layout with almost no overflow. Each spec sets the height to 560 px and keeps the project's width, so both layouts are tested.

### Task 1: WebKit is treated as Safari until 0860 task 4 says otherwise

As in 0860, the fix went in without real Safari. Where the browser keeps the offset, the restore writes the value already there. The fixture steps are in 0860 task 4.

### Task 2: added, not done

The Investigation noted the transcripts were unchecked. They use a different list and need fixture data, so they became their own task instead of widening task 1.

## Related

- [0860-multi-review-inspector-webkit-divergences.md](0860-multi-review-inspector-webkit-divergences.md): the cause, the engine-only reproduction and the hook.
