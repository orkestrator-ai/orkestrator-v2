# Multi Review package reader loses its place in WebKit when validation splits the column

Found on 2026-11-06 while running the stacked-bypass check of
to-do 0405 (retired 2026-11-10) task 8 in Playwright WebKit on
macOS, as a wider WebKit pass over the other flow-graph specs. It is not in the
pipeline graph, so 0405 left it here.

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`.

### Tasks

1. **The package reader's position is lost under WebKit when validation is published**: find a fix that keeps the reading offset across the width change, with a regression test. Status: open.

### 1. The package reader's position is lost under WebKit when validation is published

**Problem.** `validation preserves a package reader's position at 1600px` (`e2e/MultiReviewPackageLayout.spec.ts:94`) fails every time under `ORKESTRATOR_E2E_BROWSER=webkit`, in both projects (the test sets its own 1600 px viewport). The reader scrolls the package transcript tail to 200 px, "Publish validation" adds the validation table beside it, and the tail's `scrollTop` is then 0 where 200 is expected (`:122`). The 390 px case passes. Chromium passes both.

**Context.** The tail is `TranscriptTailLog` in `apps/web/src/components/review/MultiReviewInspector.tsx:191`, a `role="log"` scroller that is itself `container-type: inline-size` and holds a second `@container` child. It already uses `useScrollOffsetAcrossHide` (`apps/web/src/hooks/useScrollOffsetAcrossHide.ts`), the fix to-do 0860 (retired 2026-11-10; see [build-pipeline-view.md](../../architecture/build-pipeline-view.md#shared-flow-graph)) made for WebKit dropping a container-query scroller's offset across `display: none`. Here nothing is hidden: the element stays mounted (the test asserts it is the same element) and only its width changes.

**Investigation.** The failure is not caused by the 0405 branch: it fails the same way with that branch's one renderer change (`FlowViewport.tsx`) set back. A temporary probe (not kept) logged the tail's `scroll` and `ResizeObserver` callbacks around the publish, at 1600 px in the desktop project:

| Engine | Sequence after "Publish validation" | Final `scrollTop` |
| --- | --- | --- |
| Chromium | resize at 200 (`clientWidth` 1535), resize at 200 (`clientWidth` 759) | 200 |
| WebKit | resize at 200 (`clientWidth` 1550), `scroll` at 0 (`clientHeight` 465, `scrollHeight` 6698), resize at 0 (`clientWidth` 766) | 0 |

So WebKit resets the offset of an inline-size container scroller when its width changes, with `scrollHeight` unchanged, and reports it as an ordinary `scroll` event. This is the same engine behaviour 0860 recorded for a hide, reached by a resize instead. The 390 px case is already stacked, so publishing changes no width there. Not checked: whether a plain scroller (no container query) keeps its offset in WebKit on the same resize, which would show moving `@container` off the scroller fixes it; 0860 found that a child container is enough to trigger the hide case.

**Decisions.**

- **How to keep the offset?**
  - **Extend `useScrollOffsetAcrossHide` (or a sibling hook) to treat a width change as it treats a show: remember the offset from the last `scroll` seen before the observer reports a new width, ignore a `scroll` to 0 that arrives with an unchanged `scrollHeight` between the two observer callbacks, and restore the remembered offset there (recommended).**
    - Pros: one mechanism for both WebKit losses; every scroller that already uses the hook (the transcript tail, the Multi Review, pipeline and graph run overviews) gets it; independent of why the engine drops the offset.
    - Cons: telling an engine reset from a reader scrolling to the top during a resize needs care; the observer's first callback here comes before the reset, so the order has to be tested in WebKit, not only in happy-dom.
  - **Move `container-type` off the tail and its child.**
    - Pros: no extra state, if the plain scroller keeps its offset.
    - Cons: not yet shown to work (see Investigation); the container queries that lay out the tail's rows would need another source of width.
  - **Skip the case under WebKit.**
    - Pros: a WebKit run goes green at once.
    - Cons: leaves a reader on Safari or an iPhone losing their place whenever validation lands; this is a real app defect, not a harness limit.

## Current state

Under Playwright WebKit build 2370 (Playwright 1.64.0) on macOS, run headless
against the component fixture server: `e2e/GraphRunFlow.spec.ts`,
`e2e/MultiReviewFlow.spec.ts` and `e2e/MultiReviewPackageLayout.spec.ts` gave
122 passed, 6 skipped and these 2 failed. Both failures are this case.

## Outstanding work

Task 1. The real-Safari and iPhone check that follows it is on the
[manual-test checklist](../manual-test/7568-manual-test-checklist.md).

## Needs verification

- Whether a scroller without a container query keeps its offset across the
  same width change in WebKit (task 1's second option).

## Related

- to-do 0860 (retired 2026-11-10; see [build-pipeline-view.md](../../architecture/build-pipeline-view.md#shared-flow-graph)): the same engine behaviour on a hide, and the hook that fixed it
- [build-pipeline-view.md](../../architecture/build-pipeline-view.md#restarting-a-step): the stacked bypass whose WebKit run (to-do 0405 task 8, retired 2026-11-10) found it
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 2, the check in desktop Safari and on an iPhone) moved there on 2026-11-10.
