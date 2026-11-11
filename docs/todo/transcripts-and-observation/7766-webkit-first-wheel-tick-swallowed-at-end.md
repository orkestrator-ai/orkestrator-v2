# WebKit swallows the first wheel tick from a transcript's end

## Task analysis

Analysed 2026-11-11 against main at `14df96544`.

### Tasks

1. **Find why the first wheel tick from the end is cancelled in WebKit and fix it in the app**: open.
2. **Put the single-tick assertion back in `e2e/InspectorTranscriptHide.spec.ts`**: open (depends on 1).

### 1. Find why the first wheel tick from the end is cancelled in WebKit and fix it in the app

**Problem.** A reader at the end of an inspector transcript who wheels up once
in WebKit (Safari's engine) can stay at the end: the tick moves nothing. The
second tick scrolls normally. A Safari user loses their first attempt to
scroll back.

**Context.** `e2e/InspectorTranscriptHide.spec.ts` wheels up from the end
before most of its assertions. Commit `6cdc3e629` made its `wheelUpFromEnd`
helper repeat the tick until the reader is 100 px clear, because the single
tick failed CI's Mobile shell (webkit) job on most pull requests. The review
of that branch pointed out that the retry hides a product behaviour rather than
test timing. The spec's comment now names this to-do. The likely mechanism
(not yet confirmed in the app): WebKit animates a wheel scroll, the list's
height shrinks as the animation starts, the browser clamps the offset, and the
clamp cancels the animation. This is close to, but not the same as, the
Virtuoso upward-scroll limitation in
[transcript-scroll.md](../../architecture/transcript-scroll.md#known-limitations).

**Investigation.** Measured on 2026-11-11 in Docker with
`mcr.microsoft.com/playwright:v1.64.0-noble`, the host's Playwright 1.65.0 and
its WebKit build 2388, `ORKESTRATOR_E2E_BROWSER=webkit`, with a version of the
spec that sent one tick and asserted the reader left the end (bottom gap
greater than 1 px) on every view except fanout:

- Fanout (`/pipeline-flow?scenario=fanout&...`): 4 of 4 single ticks left the
  reader at the end, per `6cdc3e629`'s commit message.
- Building (`/pipeline-flow?scenario=building&...`): 1 of 68 single ticks left
  the reader at the end (bottom gap 0 after 5 s, `desktop-chromium` project).
  Two more ticks left the end but stopped 89 and 94 px from it, short of the
  spec's 100 px threshold.
- Graph Run and the validation scenario: 0 of 24 each. Too few runs to rule
  the defect out there.

So the defect is not specific to fanout, though fanout hits it almost every
time. A spec that exempts only fanout from the single-tick assertion fails CI
intermittently on the other views, so the retry still covers every view.

**Decisions.**

- **Where to fix it?**
  - **In the transcript scroll controller or Virtuoso adapter, by not letting
    the list shrink (or the offset be rewritten) while a wheel animation is
    starting at the end (recommended).**
    - Pros: fixes the reader's experience, not just the spec; the controller
      already classifies wheel intent (`scroll-input.ts`).
    - Cons: needs a WebKit reproduction in the app's own unit or browser
      tests; the shrink may come from Virtuoso's row measurement, which the
      app does not own.
  - **Leave it as a known limitation in transcript-scroll.md.**
    - Pros: no code risk.
    - Cons: Safari readers keep losing the tick, and the spec keeps a retry
      that would hide a regression.

### 2. Put the single-tick assertion back in `e2e/InspectorTranscriptHide.spec.ts`

**Problem.** `wheelUpFromEnd` repeats the tick for up to 10 s, so the spec no
longer proves that one tick leaves the end in any view.

**Context.** Once task 1 is fixed, the helper should send one tick and assert
the reader left the end. It can still wheel on to a 100 px gap, because a
WebKit tick under load can stop short of 100 px (see task 1's measurements).

**Investigation.** None yet; this waits on task 1.

**Decisions.**

- **What to assert after the fix?**
  - **One tick, then a bottom gap greater than 1 px, then wheel on until it is
    over 100 px (recommended).**
    - Pros: proves the defect is gone without depending on how far one tick
      travels under load.
    - Cons: two polls instead of one.
  - **One tick and a bottom gap greater than 100 px, as before `6cdc3e629`.**
    - Pros: simplest.
    - Cons: fails intermittently in WebKit when a tick stops short of 100 px.

## Constraints and rationale

The host this was measured on has no WebKit libraries (`libicu74`,
`libxml2`), so WebKit runs need the Playwright image as above.

## Related

- [transcript-scroll.md](../../architecture/transcript-scroll.md#known-limitations)
- Flake case [9981](../../tests/flaky-tests/web-ui/9981-inspector-reader-place-webkit-restore.md),
  a separate WebKit failure in the same spec seen during these runs.
