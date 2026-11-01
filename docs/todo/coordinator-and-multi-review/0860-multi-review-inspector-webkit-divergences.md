# Multi Review inspector tests fail under WebKit

Three cases in `e2e/MultiReviewFlow.spec.ts` passed in Chromium but failed every
time under Playwright WebKit. Found 2026-10-30 while qualifying task 5 of
[0029-multi-review-flow-graph.md](0029-multi-review-flow-graph.md). Two came from
one real engine difference, now fixed in the app: WebKit forgets the scroll
offset of a scroller that is, or holds, a container query container when it is
`display: none`. The third was a test-harness limit. The spec now passes under
both engines. What remains is the check in real Safari.

## Task analysis

Analysed 2026-10-31 against `main` at `931e5541`.

### Tasks

1. **Transcript follow mode after Report in WebKit**: find why the tail is not at its bottom after Report, then Transcript, and fix it or the test. Status: done (2026-10-31). App bug under WebKit.
2. **Sticky findings badge on the WebKit phone layout**: find why the badge leaves the viewport after its scroll parent moves 150 px. Status: done (2026-10-31). Sticky works; the app lost the overview's scroll position on a pane switch, and the test did not really test sticky.
3. **Touch pinch test under WebKit**: the synthetic pinch cannot run in WebKit. Status: done (2026-10-31). Test problem only; skipped under WebKit.
4. **Confirm in real Safari**: check tasks 1 and 2 in desktop Safari and on an iPhone. Status: open (needs desktop Safari and an iPhone).

### 1. Transcript follow mode after Report in WebKit

**Problem.** "an overflowing transcript keeps its reading position and follow mode behind Report" failed in both projects under WebKit. After Report, a new entry, then Transcript, the tail was 5,803 px from its bottom.

**Context.** `TranscriptTailLog` in `apps/web/src/components/review/MultiReviewInspector.tsx` keeps a `following` ref, set from the `onScroll` gap and applied in a layout effect and a `ResizeObserver`. The tail is the `@container` scroller, and Report hides it with `display: none` without unmounting it.

**Investigation.** A real bug under WebKit, not a test problem. Logging every `scroll`, resize and frame during the test showed this order when the tail is shown again:

| Engine | First sample after show | `scroll` event | `ResizeObserver` | Result |
| --- | --- | --- | --- | --- |
| Chromium | `scrollTop` 5614 | after the observer, at 5803 | re-pins to 5803 | at the bottom |
| WebKit | `scrollTop` 0 | before the observer, at 0, `clientHeight` 446 | `following` is already false | at the top |

An engine-only page with no app code reproduces the loss. It has a 200 px scroller scrolled to 1234, hides its parent, then shows it (Playwright WebKit build 2370, from Playwright 1.64.0):

| Scroller | Chromium after show | WebKit after show |
| --- | --- | --- |
| Plain | 1234, no `scroll` | 1234, no `scroll` |
| Is `container-type: inline-size` | 1234, no `scroll` | 0, `scroll` at 0 |
| Holds a child with `container-type: inline-size` | 1234, no `scroll` | 0, `scroll` at 0 |

Both guesses the file first made were wrong. `scroll` does not fire while hidden: it fires after the show, with `clientHeight` already 446, so testing `clientHeight === 0` in the handler would not catch it. The observer's timing is fine; `scrollHeight` is correct by then. The loss also takes the reader's position with it, so a reader who had scrolled up would land at the top too, which is why re-pinning alone would not do.

**Decisions.**

- **How to find the cause?**
  - **Log `following`, `scrollTop`, `scrollHeight` and each `scroll` and resize event during the test under WebKit (recommended).**
    - Pros: shows which handler turns following off; cheap.
    - Cons: needs a temporary diagnostic that must not land.
  - **Change the code first, for example re-pin to the bottom when the tail becomes visible.**
    - Pros: may fix it straight away.
    - Cons: guesses the cause; might hide a real reading-position bug in the same path.
- **How to fix it once found?**
  - **Track hidden from the `ResizeObserver`, ignore `scroll` until the observer sees the show, and put the remembered offset back there (recommended).**
    - Pros: covers both follow mode and the reading position; independent of why the engine lost the offset; reusable for the overview in task 2.
    - Cons: one more listener and observer per scroller; relies on observer creation order so the tail's re-pin runs after the restore.
  - **Ignore scroll events while `clientHeight === 0` and re-pin when shown.**
    - Pros: the smallest change.
    - Cons: does not work, because the event arrives with `clientHeight` already set; does nothing for a reader who scrolled up.
  - **Move `@container` off the tail, or hide with something other than `display: none`.**
    - Pros: avoids the engine behaviour with no extra state.
    - Cons: a child container loses the offset as well, so moving it does not help; another hiding method keeps hidden content in the accessibility and layout trees.

### 2. Sticky findings badge on the WebKit phone layout

**Problem.** "findings stay reachable, fit the viewport and scroll internally" failed only in `mobile-chromium` under WebKit. After its scroll parent moved 150 px, the findings badge was outside the viewport (ratio 0).

**Context.** The badge is `sticky top-3` in the grid inside `multi-review-overview-scroll`. Just before the failing line the test hides and shows the pane, as `PaneLeafContainer` does with `display: none` when another tab takes over.

**Investigation.** Sticky positioning is fine in both engines, and both walk to the same scroller with the same containing block. The app lost the scroll position, and the test was also weak. Snapshots through the test's steps match in both engines (`scrollTop` 635, badge at y 417.75) until the pane switch:

| After hide and show | Chromium | WebKit |
| --- | --- | --- |
| Overview `scrollTop` | 970, its maximum, was 635 | 0, was 635 |
| Badge y (scroller ends at 783) | 97, stuck at `top-3` | 1052.75 |
| After the test's `+= 150` | 970, no movement | 902.75, still below the scroller |

So there were two app causes and one test fault:

1. **Both engines.** `FlowGraph` set its measured width and height to null when a hidden tab measured 0. A null width turned the phone's stacked column into the wide graph, so on show the content was 490 px short for one frame (`scrollHeight` 1178, then 1668). Chromium clamped to 480 and scroll anchoring carried it to 970. It also reset the wide graph's zoom and moved its pan: 150% came back as 100%, and a vertical pan of 40 px came back as 2.
2. **WebKit only.** The same engine behaviour as task 1 took the overview to 0, because it holds a `@container` child.
3. **Test.** In Chromium the `+= 150` moved nothing, as the scroller was already at its maximum, so the check passed without moving anything. Under WebKit it could never pass from `scrollTop` 0.

**Decisions.**

- **Is it the app or the test?**
  - **First check which element the test scrolls in WebKit and where the badge's sticky containing block is (recommended).**
    - Pros: settles whether a user would see it before anyone changes code.
    - Cons: none worth noting.
  - **Assume it is the app and change the sticky layout.**
    - Pros: none if the test is at fault.
    - Cons: risks breaking the Chromium layout for a test artefact.
- **What to change?**
  - **Keep the last measurement while hidden, keep the overview's offset with the task 1 hook, and make the test assert the kept offset and the stuck position (recommended).**
    - Pros: fixes what a reader sees in both engines; the test now fails for the real reason.
    - Cons: touches `FlowGraph`, shared with Build Pipeline and Graph Run. `PipelineFlow.spec.ts` passes on both engines; Graph Run has no browser spec, only its unit tests.
  - **Fix only the test, by scrolling to the end before the sticky check.**
    - Pros: smallest change; WebKit goes green.
    - Cons: leaves the lost position and the lost zoom in place for users.

### 3. Touch pinch test under WebKit

**Problem.** "a two-finger pinch zooms the stacked column on touch" threw `TypeError: Illegal constructor` under WebKit, because desktop WebKit has no `Touch` constructor.

**Context.** The test builds `Touch` and `TouchEvent` objects in the page. Only the harness failed; the handler was never reached.

**Investigation.** The error is thrown before any event is sent, so this says nothing about the app. It is now skipped under WebKit, with the reason in the skip message.

**Decisions.**

- **What to do with it?**
  - **Skip the case when `browserName` is `webkit`, with the reason in the skip message (recommended).**
    - Pros: the config comment already says engine-specific specs should gate on `browserName`; a WebKit run then shows only real failures.
    - Cons: no synthetic touch pinch under WebKit; the real-device check in 0029 task 5 covers it.
  - **Build the pinch with CDP or `page.touchscreen` instead.**
    - Pros: would run on both engines.
    - Cons: Playwright's touchscreen has no multi-touch, and CDP is Chromium-only.

### 4. Confirm in real Safari

**Problem.** Playwright WebKit is not Safari, so the engine behaviour in task 1 might not reach users. The fix is harmless either way, because restoring an offset the browser kept changes nothing.

**Context.** It fits the 0031 Safari and iOS session, alongside 0029 task 5. No fixture run stands in for it: it needs desktop Safari and an iPhone, which this worker did not have.

**Investigation.** Not run. Steps:

1. **Engine check, no app needed.** Open this page in each browser, wait a second, and read the result. `1234` means the engine keeps the offset; `0` means real Safari behaves as Playwright WebKit does.
   ```html
   <!doctype html><div id=p><div id=s style="height:200px;overflow-y:auto;container-type:inline-size"><div style="height:5000px">x</div></div></div><pre id=o></pre>
   <script>s.scrollTop=1234;setTimeout(()=>{p.style.display="none";setTimeout(()=>{p.style.display="";setTimeout(()=>{o.textContent=s.scrollTop},200)},200)},200)</script>
   ```
2. **App check.** Serve the fixture as in 0029 task 5, step 1, and record device, OS and browser versions.
3. Open `/multi-review-flow?phase=ready&longTranscript&transcriptControls`, then select Reviewer 1. Scroll to the bottom, open Report, press Append transcript entry, return to Transcript: the newest entry must be in view. Scroll up, repeat: the same reading position must come back.
4. Open `/multi-review-flow?phase=reviewing&reviewers=4&manyFindings&paneControls` on the phone. Scroll to the findings badge, press Activate other pane, then Activate review pane: the page must not move. Scroll to the end: the badge stays 12 px below the top of the scroll area.
5. On desktop at a wide window, open `/multi-review-flow?phase=reviewing&reviewers=8&paneControls`. Zoom to 150% and pan, then switch panes and back: zoom and pan must be kept.
6. Open `/pipeline-flow?scenario=fanout&paneControls` and `/graph-run-flow` ([1080](1080-flow-view-overview-scroll-across-hide.md)). Scroll each overview part way down, press Activate other pane, then Activate build pane or Activate graph pane: the overview must not move.

**Decisions.**

- **Fix before or after the real-Safari check?**
  - **After task 1's diagnosis, fix whatever the diagnosis shows is engine-independent, then confirm in Safari (recommended).**
    - Pros: does not wait on hardware for a fix that is right anyway.
    - Cons: a fix may land for a case real Safari never hits.
  - **Wait for the Safari check.**
    - Pros: no work on a possible non-issue.
    - Cons: the WebKit run stays red until someone has the hardware.

## Assumptions and decisions

### Task 1: a hook rather than the file's first recommended fix

Chose `useScrollOffsetAcrossHide` in `apps/web/src/hooks/`, which takes hidden from the `ResizeObserver` and restores the offset there. The file recommended ignoring `scroll` at `clientHeight === 0`, but the log shows the event arrives with `clientHeight` already 446, so that check never fires. The reading position is lost too, so the fix also takes the part of the file's second option that remembers the position. `following` stays the single source of follow mode, so nothing has to be kept in step with it.

### Task 1: the WebKit behaviour is treated as real until task 4 says otherwise

The offset loss is reproduced with no app code, but only in Playwright WebKit. The fix went in without waiting for real Safari, as the file recommends: where the browser keeps the offset, the restore writes the value already there.

### Task 2: fixed the app and the test

The failure looked like a sticky bug and was not one. Changing only the test would have turned WebKit green and left the lost position in both engines. The test now asserts the offset is kept across the pane switch. Then it scrolls to the end and, on the stacked layout, asserts the badge is 12 px below the scroller's top. On the wide layout the page cannot scroll far enough to stick, so there it asserts only that the badge is in the viewport.

### Task 2: keep the last measured size while hidden

`useMeasuredWidth` and `useMeasuredHeight` now keep their last value when a hidden tab measures 0, in place of going back to null. This is in shared `FlowGraph`, and it also fixes the wide graph's zoom and pan reset on a pane switch, which this file had not listed. `e2e/MultiReviewFlow.spec.ts` gained a case for that, and `MultiReviewFlow.spec.ts` and `PipelineFlow.spec.ts` pass on both engines. Graph Run has no browser spec, so only its unit tests cover it. A size change while hidden is still picked up on show, because the next measurement differs.

### Task 2: other overview scrollers left for a follow-up

Build Pipeline and Graph Run have the same scroller shape, a `@container` child inside `overflow-y-auto`. The Build Pipeline fixture has no way to hide the pane and Graph Run has no fixture, so a fix there could not be shown working here. They went to [1080](1080-flow-view-overview-scroll-across-hide.md).

### Task 3: skip under WebKit only

Followed the recommended option. The skip is on `browserName === "webkit"`, placed before navigation.

### Task 4: left open

Needs hardware this worker did not have, as the brief says. The steps above now start with a one-page engine check.

## Related

- [0029-multi-review-flow-graph.md](0029-multi-review-flow-graph.md): task 5, where these were found.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md): the Safari and iOS session.
- [1080-flow-view-overview-scroll-across-hide.md](1080-flow-view-overview-scroll-across-hide.md): the same scroll loss in Build Pipeline and Graph Run.
