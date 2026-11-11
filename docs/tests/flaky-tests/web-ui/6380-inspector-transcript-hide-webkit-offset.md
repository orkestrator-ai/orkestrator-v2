# Inspector transcript hide: a review report's first offset under WebKit

- **ID:** 6380
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Test:** `Build Pipeline with a review report shows the newest message when its pane returns`
- **File:** `e2e/InspectorTranscriptHide.spec.ts:74`
- **Browser:** Playwright WebKit (`ORKESTRATOR_E2E_BROWSER=webkit`), both viewports

Resolved 2026-11-06. Two causes: an engine clamp, fixed in the app, and the
spec recording the reader's offset while it was still moving, fixed in the spec
(see [Second cause](#second-cause-the-readers-offset-was-read-while-it-was-still-moving)).

Reported at about 75% of runs on WebKit. In the `mobile-shell-browser` job on
`main`, the step `inspector-transcript-webkit` failed in 4 of the 5 completed CI
runs from 2026-11-05 checked:

| Run | Commit | `inspector-transcript-webkit` |
| --- | --- | --- |
| 42095512494 | `44d22d844` | failed |
| 42095657507 | `8c1c54c10` | failed |
| 42095680675 | `009da1548` | failed |
| 42095902842 | `209b1249b` | failed |
| 42096069100 | `41f9eb638` | no failure in the failed-steps log |

In all four failures this view failed and the other two views in the spec
(`Build Pipeline`, `Graph Run`) did not. The failing assertion (line 125) compares
the transcript's offset in its first visible frame after the show with the
reader's offset recorded before the hide: `mobile-chromium` received 12686 in all
four runs (expected 12688, 12715, 12707, 12759) and `desktop-chromium` received
11953 in the three runs that failed there (expected 12005, 11991, 12004). The
expected value varies and the received one does not. This is the brief offset
to-do 5620 (retired 2026-11-11; see
[transcript-scroll.md](../../../architecture/transcript-scroll.md#activation-and-persistence)),
task 2, describes. CI runs on 2026-11-06 (42222311479, 42222507446, 42222625263,
42223318261, 42224936443) failed the same way at line 125, with received values
11953 or 12153 on desktop and 12686 on the phone.

```sh
ORKESTRATOR_E2E_BROWSER=webkit mise run test:logged -- --name inspector-transcript-webkit -- bunx playwright test --config e2e/playwright.config.ts e2e/InspectorTranscriptHide.spec.ts --workers=1
```

Not reproduced on beelink on 2026-11-05: Playwright's WebKit could not launch
there (missing `libicu74`, `libxml2`, `libflite1`).

## Reproduction

Reproduced on 2026-11-06 in Docker with `mcr.microsoft.com/playwright:v1.64.0-noble`
(the image for the repository's Playwright 1.64.0, WebKit build 2370), the
worktree mounted at its own path and the host's Bun 1.4.4:

```sh
ORKESTRATOR_E2E_BROWSER=webkit bun x playwright test --config e2e/playwright.config.ts e2e/InspectorTranscriptHide.spec.ts --workers=1 --repeat-each=3
```

Before the fix: 14 passed, 4 failed, all four this view at line 125 (one
`mobile-chromium`, three `desktop-chromium`; for example expected 12242, received
12153).

## Root cause

An engine behaviour, which the app did not undo. WebKit puts a re-shown
scroller's offset back during a layout that has not yet sized the contents of a
container query container inside it, so the offset is clamped to a scroll range
short by that content. In this fixture the container is
`StructuredReviewReportView` (`@container`) in the transcript's footer; its
contents were 466 px tall on desktop, and only its padding and border (42 px)
counted when the offset was clamped. WebKit then fires `scroll` at the clamped
offset, before the frame's animation callbacks, so the spec's first-frame probe
read it.

Evidence:

- **Constant received value.** The received value is the clamped maximum, which
  depends only on the content height, while the expected value depends on how far
  the wheel moved the reader. A logged run on desktop: reader at 12017 and 11987,
  scroll height 12693, client height 274 (true maximum 12419); after the show,
  `scroll` fired at 11953 = 12693 − 274 − 466 in both. A reader at 11610, below
  that limit, kept their offset and the test passed. That is why the failure
  rate depended on the wheel's landing point.
- **Engine-only page.** A 300 px scroller over a 5000 px block, followed by a
  `container-type: inline-size` footer with 466 px of content, scrolled to 5108
  (maximum 5208), then its parent hidden and shown. WebKit returned 4742 =
  5508 − 300 − 466 and fired `scroll`; without `container-type` it kept 5108.
  Chromium kept 5108 in both. `contain-intrinsic-size` on the container did not
  change it. A synchronous write of 5108 straight after the show held, in WebKit
  too, so the range is correct by the time script runs.
- **The same cause explains 5620 task 2.** A follower at the end is clamped by the
  same amount: 5620's desktop table has 12443 → 11977, which is 466 px short.

This probably also accounts for the reset to 0 that
to-do 0860 (retired 2026-11-10; see [build-pipeline-view.md](../../../architecture/build-pipeline-view.md#shared-flow-graph))
found: when the scroller is, or wraps, the container, none of its content is
sized at that point and the range would be 0 (inferred, not measured).

## Fix

`TranscriptScrollController` (`apps/web/src/lib/transcript-scroll/transcript-scroll-controller.ts`)
keeps the offset it last observed while the scroller had a box. When a resize
delivery measures the scroller at zero height it notes the hide; on the first
`scroll` or resize delivery after the show, whichever comes first, it writes
that offset back through the adapter, unless a navigation started since the
show (activation) owns the viewport. It only writes upward, because the engine's
clamp only lowers the offset while the virtualizer following growth raises it.
That `scroll` is not treated as the reader's, so a follower is not released by
it. Chromium keeps the offset, so there nothing is written. The fix is in the transcript, not the spec: no
assertion, timeout or retry changed.

`transcript-scroll-controller.test.ts` ("an offset across a hide") covers a
clamped reader, a clamped follower, an engine that keeps the offset (no write),
following growth since the show (not undone) and a navigation started after the
show (not undone). Without the fix the first two fail; without the navigation
guard the last fails.

## Verification

All in the Docker image above, `--workers=1`, on 2026-11-06:

| Engine | Command | Result |
| --- | --- | --- |
| WebKit, before the fix | `e2e/InspectorTranscriptHide.spec.ts --repeat-each=3` | 14 passed, 4 failed (all the clamp) |
| WebKit, first version of the fix | `e2e/InspectorTranscriptHide.spec.ts --repeat-each=5` | 30 passed |
| WebKit, first version of the fix | `e2e/InspectorTranscriptHide.spec.ts --repeat-each=10` | 58 passed, 2 failed (see below) |
| WebKit, final fix | the spec with logging added, assertions unchanged, `--repeat-each=40` | 237 passed, 3 failed (all the cause below) |
| WebKit, final fix | `e2e/InspectorTranscriptHide.spec.ts --repeat-each=10` | 60 passed |
| Chromium, final fix | `e2e/InspectorTranscriptHide.spec.ts --repeat-each=10` | 60 passed |
| WebKit, both fixes | `e2e/InspectorTranscriptHide.spec.ts --repeat-each=40` | 240 passed |
| Chromium, both fixes | `e2e/InspectorTranscriptHide.spec.ts --repeat-each=10` | 60 passed |

No run after the app fix failed with the clamp, and no run after the spec fix
failed at all.

## Second cause: the reader's offset was read while it was still moving

In WebKit, `page.mouse.wheel(0, -600)`
scrolls with an animation, and Virtuoso then corrects for rows that measured
shorter than estimated (`scrollBy` by −200 px or −109 px in the logs). The spec
read `readerOffset` once `bottomGap` passes 100 and the overview has been moved,
which can be before that movement ends. The transcript then keeps moving before
the hide, and the first frame after the show is, correctly, where the reader
was at the hide.

Evidence from the logged run (a capturing `click` listener read the
transcript's offset as the hide was clicked):

| Project | View | `readerOffset` | Offset at the hide | First frame |
| --- | --- | --- | --- | --- |
| mobile | Build Pipeline with a review report | 12939 | 12696 | 12696 |
| desktop | Build Pipeline with a review report | 12707 | 12253 | 12253 |
| desktop | Build Pipeline | 10898 | 10698 | 10698 |

The other 237 runs matched exactly. CI showed this cause before the fix too, as
the failures whose received value was not the clamp: expected 12120 received
11920, expected 12085 received 11685, expected 12117 received 11717, expected
12069 received 11669, expected 12716 received 11363, and `Graph Run` on the
phone, expected 11631 received 11406, in about 105 failing CI runs scanned on
2026-11-06. `e2e/MultiReviewFlow.spec.ts` records a reading position the same
way and fails in WebKit for the same reason, independent of this change: both
of its overflowing-transcript tests failed 6 of 6 in WebKit with the controller
change reverted (received about 20 px above the recorded offset). That spec is
not in the WebKit CI job.

Fix, in the spec: `settledOffset` records `readerOffset` only once the
transcript's `scrollTop` has held for 5 consecutive animation frames (failing
if it never does within 3 seconds), so the first frame is compared with where
the reader settled. It is a setup-timing change: the `bottomGap` > 100 check,
the `readerOffset` > 100 check and the exact equality at the first-frame
assertion are unchanged. `e2e/MultiReviewFlow.spec.ts` still records its
reading position the old way and still fails in WebKit; it is not in CI and was
left unchanged.

One `Graph Run` failure at line 63 (`samples.length` was 1 in the follower's
settling check) appeared once in the first 10× run and not in 50 further `Graph
Run` runs or the 40× run; its cause was not found.
