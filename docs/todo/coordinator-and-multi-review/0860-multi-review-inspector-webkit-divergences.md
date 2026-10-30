# Multi Review inspector tests fail under WebKit

Three cases in `e2e/MultiReviewFlow.spec.ts` pass in Chromium but fail every
time under Playwright WebKit. Two are about the Multi Review inspector: the
transcript tail's follow mode after the Report view, and the sticky findings
badge on the phone layout. The third is a test-harness limit. Found
2026-10-30 while qualifying task 5 of
[0029-multi-review-flow-graph.md](0029-multi-review-flow-graph.md). If real
Safari behaves the same way, a Safari web-client user who goes back from
Report to Transcript sees the top of a long transcript, not its newest line.

## Task analysis

Analysed 2026-10-30 against `main` at `cd7bbe3e`.

### Tasks

1. **Transcript follow mode after Report in WebKit**: find why the tail is not at its bottom after Report, then Transcript, and fix it or the test. Status: open.
2. **Sticky findings badge on the WebKit phone layout**: find why the badge leaves the viewport after its scroll parent moves 150 px. Status: open.
3. **Touch pinch test under WebKit**: the synthetic pinch cannot run in WebKit. Status: open.
4. **Confirm in real Safari**: check tasks 1 and 2 in desktop Safari and on an iPhone. Status: open (depends on 1 and 2).

### 1. Transcript follow mode after Report in WebKit

**Problem.** "an overflowing transcript keeps its reading position and follow mode behind Report" fails in both projects under WebKit. The tail scrolls to its bottom first, the reader opens Report, a new entry arrives, and the reader goes back to Transcript. The tail should still be at its bottom, but it is 5,803 px from it (`e2e/MultiReviewFlow.spec.ts:781`).

**Context.** `TranscriptTail` in `apps/web/src/components/review/MultiReviewInspector.tsx:218-258` keeps a `following` ref. The ref is set from the `onScroll` gap (under `FOLLOW_THRESHOLD_PX`). It is applied in a layout effect on `messages` and in a `ResizeObserver` on the tail. While Report is open, the tail is hidden but stays mounted (the test checks it is the same element).

**Investigation.** Reproduced three times out of three with
`ORKESTRATOR_E2E_BROWSER=webkit ORKESTRATOR_E2E_PORT=14829 mise exec -- bunx playwright test -c e2e/playwright.config.ts e2e/MultiReviewFlow.spec.ts -g "overflowing transcript keeps" --repeat-each 3`.
It passes in Chromium. A 5,803 px gap means the tail is near its top. So the tail either lost its scroll position while hidden and nothing put it back, or a scroll event cleared `following` while it was hidden. Possible causes, none confirmed yet: WebKit may fire `scroll` when a hidden element's `scrollTop` is clamped to 0, so `onScroll` sees a gap and turns following off; or the `ResizeObserver` may fire before layout is restored, so `scrollHeight` is wrong when it runs. Playwright WebKit on macOS is not Safari, so this does not yet prove a Safari bug.

**Decisions.**

- **How to find the cause?**
  - **Log `following`, `scrollTop`, `scrollHeight` and each `scroll` and resize event during the test under WebKit (recommended).**
    - Pros: shows which handler turns following off; cheap.
    - Cons: needs a temporary diagnostic that must not land.
  - **Change the code first, for example re-pin to the bottom when the tail becomes visible.**
    - Pros: may fix it straight away.
    - Cons: guesses the cause; might hide a real reading-position bug in the same path.
- **How to fix it once found?**
  - **Ignore scroll events while the tail is hidden (`clientHeight === 0`) and re-pin when it is shown again (recommended).**
    - Pros: a hidden tail cannot change the reader's intent; one small change.
    - Cons: needs a visibility signal; `ResizeObserver` gives one already.
  - **Remember the reading position explicitly and restore it on show.**
    - Pros: does not depend on how the engine treats hidden scrollers.
    - Cons: more state to keep in step with follow mode.

### 2. Sticky findings badge on the WebKit phone layout

**Problem.** "findings stay reachable, fit the viewport and scroll internally" fails only in `mobile-chromium` under WebKit. After the inspector's scroll parent moves down by 150 px, the findings badge is no longer in the viewport (ratio 0, `e2e/MultiReviewFlow.spec.ts:937`).

**Context.** The badge relies on sticky positioning so it stays in view while the reader scrolls (comment at `:931` and `MultiReviewInspector.tsx:628`). The test moves the nearest scrolling ancestor by hand.

**Investigation.** Reproduced three times out of three with the command in task 1 and `-g "findings stay reachable"`. The rest of the test passes before that point under WebKit: open, close, Escape and pane changes. The cause is not known yet. Possibilities: the nearest scrolling ancestor that the test walks to differs in WebKit, so the test scrolls a different element; or WebKit resolves the sticky containing block differently in the stacked layout.

**Decisions.**

- **Is it the app or the test?**
  - **First check which element the test scrolls in WebKit and where the badge's sticky containing block is (recommended).**
    - Pros: settles whether a user would see it before anyone changes code.
    - Cons: none worth noting.
  - **Assume it is the app and change the sticky layout.**
    - Pros: none if the test is at fault.
    - Cons: risks breaking the Chromium layout for a test artefact.

### 3. Touch pinch test under WebKit

**Problem.** "a two-finger pinch zooms the stacked column on touch" throws `TypeError: Illegal constructor` under WebKit, because desktop WebKit has no `Touch` constructor.

**Context.** The test builds `Touch` and `TouchEvent` objects in the page (`e2e/MultiReviewFlow.spec.ts:394`). Only the harness fails; the handler is never reached.

**Investigation.** The error is thrown before any event is sent, so this says nothing about the app.

**Decisions.**

- **What to do with it?**
  - **Skip the case when `browserName` is `webkit`, with the reason in the skip message (recommended).**
    - Pros: the config comment already says engine-specific specs should gate on `browserName`; a WebKit run then shows only real failures.
    - Cons: no synthetic touch pinch under WebKit; the real-device check in 0029 task 5 covers it.
  - **Build the pinch with CDP or `page.touchscreen` instead.**
    - Pros: would run on both engines.
    - Cons: Playwright's touchscreen has no multi-touch, and CDP is Chromium-only.

### 4. Confirm in real Safari

**Problem.** Playwright WebKit is not Safari, so tasks 1 and 2 might not reach users.

**Context.** It fits the 0031 Safari and iOS session, alongside 0029 task 5.

**Investigation.** Not run. Steps: serve the fixture as in 0029 task 5, step 1. Then open `/multi-review-flow?phase=ready&longTranscript&transcriptControls` and `/multi-review-flow?phase=reviewing&reviewers=4&manyFindings&paneControls` in desktop Safari and on an iPhone, and repeat the test's actions by hand.

**Decisions.**

- **Fix before or after the real-Safari check?**
  - **After task 1's diagnosis, fix whatever the diagnosis shows is engine-independent, then confirm in Safari (recommended).**
    - Pros: does not wait on hardware for a fix that is right anyway.
    - Cons: a fix may land for a case real Safari never hits.
  - **Wait for the Safari check.**
    - Pros: no work on a possible non-issue.
    - Cons: the WebKit run stays red until someone has the hardware.

## Related

- [0029-multi-review-flow-graph.md](0029-multi-review-flow-graph.md): task 5, where these were found.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md): the Safari and iOS session.
