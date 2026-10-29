# Mobile title tooltip stays open after an outside tap in WebKit

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Find and fix the WebKit outside-tap dismissal**: an outside touch tap leaves the title tooltip open in Playwright's WebKit. Status: done (fixed in #1322; re-verified 2026-10-29, see Assumptions and decisions 5 and 6).
2. **Decide whether CI runs the spec under WebKit**: the spec is opt-in under WebKit today. Status: done (CI's `mobile-shell-browser` job runs it in Chromium and WebKit; see decision 7).
3. **Qualify on iOS Safari**: tap the title, then the workspace, on a device or simulator, before and after the fix. Status: open (a 2026-10-27 run is recorded below, but it could not be repeated on 2026-10-29 because `simctl` hung on this Mac; see decision 8; batched with [0031](0031-live-provider-and-platform-qualification.md)).

### 1. Find and fix the WebKit outside-tap dismissal

**Problem.** On a phone the truncated shell title opens a tooltip on tap, and a tap elsewhere should close it. In Playwright's WebKit it stays open, so a touch user who opened it can only close it by tapping the title again.

**Context.** Found while qualifying [0035](0035-mobile-layout-gaps.md). The tooltip is the only touch path to a truncated title. The title's own touch toggle must keep working.

**Investigation.** The component and test are as described: the controlled tooltip is at `apps/web/src/components/layout/MobileAppShellLayout.tsx:233`, its touch toggle records the pointer type in `onPointerDown` (`:247`) and flips state in `onClick` (`:255`-`:268`); the failing step is the outside tap at `e2e/MobileAppShellLayout.spec.ts:85` with the assertion at `:86`, run in the `mobile-chromium` project (`e2e/playwright.config.ts:43`, 390 x 844, `hasTouch`) with `ORKESTRATOR_E2E_BROWSER=webkit` (`e2e/playwright.config.ts:12`).

The file's likely cause is out of date for the pinned Radix. `@radix-ui/react-tooltip` 1.4.1 uses `@radix-ui/react-dismissable-layer` 1.2.1 (`bun.lock:751`). In that version a pointerdown outside is deferred to the following `click` only when the layer sets `deferPointerDownOutside` (default `false`, `dist/index.mjs:194` and `:265`-`:273`); the tooltip content does not set it (`react-tooltip/dist/index.mjs:339`-`:346`). So an outside `pointerdown` dismisses at once whatever the pointer type; there is no touch-specific wait for `click` any more. The remaining explanations are that WebKit's emulated touch tap delivers no `pointerdown` to the document (the title might still open and close through focus and `click`, which do not need one), or that the event reaches the layer but is treated as inside. Not reproduced here: running the WebKit spec needs the e2e web server, which this analysis did not start.

**Decisions.**

- **How to find the cause?**
  - **Instrument the spec run: log the `pointerdown`, `touchstart` and `click` events the document receives for the outside tap in WebKit and Chromium (recommended).**
    - Pros: settles which event is missing in one run; the fix follows directly.
    - Cons: needs a temporary listener in the spec or the page.
  - **Apply the file's suggested fix blind (close on outside `pointerdown` for touch).**
    - Pros: quick to try.
    - Cons: Radix already closes on outside `pointerdown`; if WebKit sends none, this fix does nothing.
- **Where should the fix live, once the cause is known?**
  - **In `MobileAppShellLayout`, as a document `touchstart` or `pointerdown` listener active only while `titleTooltipOpen` is true, ignoring the title itself (recommended).**
    - Pros: local to the one touch-opened tooltip; does not change every tooltip's behaviour.
    - Cons: duplicates part of Radix's dismissal; must not race the title's own toggle.
  - **In the shared `apps/web/src/components/ui/tooltip.tsx`.**
    - Pros: fixes any future touch-opened tooltip.
    - Cons: every other tooltip is hover-driven, so it widens the change for no current gain.

### 2. Decide whether CI runs the spec under WebKit

**Problem.** WebKit coverage of the mobile shell is opt-in, so a WebKit-only regression can return unnoticed.

**Context.** CI runs Chromium only; no workflow under `.github/workflows/` sets `ORKESTRATOR_E2E_BROWSER`. `e2e/AgentLaunchDialog.spec.ts:8` already gates on a non-Chromium engine, so the override is in use for qualification.

**Investigation.** Running the whole `mise run test:browser` suite under WebKit in CI would need the WebKit browser in the CI image and would run every spec, including ones that require Chrome or CDP.

**Decisions.**

- **What should CI run under WebKit?**
  - **Only `e2e/MobileAppShellLayout.spec.ts` in the `mobile-chromium` project, after the fix lands (recommended).**
    - Pros: guards exactly the regression found; small runtime cost.
    - Cons: one more browser download in CI; Playwright WebKit is not iOS Safari, so it is still a proxy.
  - **Keep WebKit opt-in for qualification runs only.**
    - Pros: no CI cost.
    - Cons: the fix is unguarded.
  - **Run the full e2e suite under WebKit.**
    - Pros: widest coverage.
    - Cons: needs per-spec gating for Chrome-only specs; much longer runs.

### 3. Qualify on iOS Safari

**Problem.** Playwright's WebKit runs on the desktop host with emulated touch and may not match iOS Safari, so it is unknown whether real users see this.

**Context.** The open question in the file. Batched with the Safari and iOS runs in [0031](0031-live-provider-and-platform-qualification.md).

**Investigation.** No iOS run is recorded. iOS Safari historically does not fire `click` for taps on non-interactive content without a click handler or `cursor: pointer`, but it does fire `touchstart`/`pointerdown`, so the result may differ from Playwright's WebKit.

**Decisions.**

- **When to run it?**
  - **Once before the fix and once after, in the same iOS session as 0035's iOS run (recommended).**
    - Pros: shows whether the bug is real on iOS and that the fix works there; shares setup with 0035.
    - Cons: needs a Mac with a simulator or a device, which this host cannot provide.
  - **Only after the fix.**
    - Pros: one run.
    - Cons: cannot tell whether iOS was ever affected, which decides how much the fix matters.

Found on 2026-10-26 while qualifying
[0035-mobile-layout-gaps.md](0035-mobile-layout-gaps.md) in Playwright's
WebKit, against `main` at `93018933`. Fixed on 2026-10-27 against `main` at
`863b5782`.

On a phone the shell's title truncates. Tapping it opens a tooltip with the
whole title (`MobileAppShellLayout`, a controlled Radix `Tooltip` driven by
`titleTooltipOpen`), and tapping anywhere else should close it. In Chromium it
closed. In WebKit it stayed open.

## Current state

- **Cause: the "outside" tap was on the tooltip itself.** The spec tapped the
  centre of the "Workspace" text (y 44–68 in the 390 × 844 fixture), but the
  tooltip bubble covers y 48–94, so `pointerdown` landed on the tooltip
  content in both engines. Radix's `DismissableLayer` rightly treats that as
  inside and does nothing. Chromium closed the tooltip anyway because a tap
  focuses the title button, and the tap's `mousedown` on non-focusable
  content blurred it (Radix's trigger closes on blur). WebKit never focuses a
  tapped button, so nothing closed it. The todo's first guess (Radix waits
  for a `click` that WebKit does not send) was wrong: the tooltip's layer
  does not defer, and it dismisses on the outside `pointerdown` itself. A tap
  that really is outside the bubble already closed it in WebKit and on iOS.
  Event traces are in decision 1.
- **Fix.** `TooltipContent` in `MobileAppShellLayout.tsx` closes the tooltip
  on `touchend` and cancels that `touchend`, which also cancels the tap's
  compatibility mouse events and click, so the tap does not reach the
  workspace control under the bubble. A pen tap, which has no touch events,
  closes it from the bubble's click (`pointerType === "pen"`). The title's
  own touch toggle, keyboard activation, Escape, hover and blur are
  unchanged.
- **Tests.**
  - `e2e/MobileAppShellLayout.spec.ts` now taps the bubble (it closes, and a
    document click counter stays at 0), then reopens the tooltip and taps
    200 px below it, a true outside tap. The spec failed at the bubble step
    in WebKit with the old layout and passes with the fix.
  - `MobileAppShellLayout.test.tsx` adds "closes the title tooltip from a
    touch or pen tap on the bubble" (happy-dom): `touchEnd` on the bubble is
    cancelled and closes it, and a pen click closes it. It fails without the
    fix and runs in CI as part of `mise run test`.
- **Engine and device runs (2026-10-27).**
  - `ORKESTRATOR_E2E_BROWSER=webkit` (WebKit 27.2), `chromium` and `firefox`
    (157.0), `MobileAppShellLayout.spec.ts --repeat-each 3`, all projects:
    every run passed (WebKit 9 passed and 15 skipped, Chromium 12 and 12,
    Firefox 9 and 15; the skips are project- or engine-gated cases).
  - iOS 26.5 Simulator (iPhone 17), Safari against the component fixture
    server (`/mobile-shell`), taps sent through Xcode's Device Hub window. Before
    the fix: tapping the title opened the tooltip; a tap on the bubble, at
    its top edge and at its centre, left it open; a tap in the workspace
    below closed it. So iOS Safari behaves like Playwright's WebKit here.
    After the fix: title opens it, a bubble tap closes it, title reopens it,
    a tap below closes it, and title taps toggle it. With a temporary button
    under the bubble (not committed), the bubble tap closed the tooltip and
    left the button's count at 0, and a second tap at the same point counted 1. Screenshots
    are scratch output under the ignored `output/qualification-0202-ios/`.

## Outstanding work

### Code

1. **Done (2026-10-27): find out why an outside tap does not close the
   tooltip in WebKit, and fix it.** The tap was on the bubble, not outside it,
   and only Chromium's focus blur closed it (see Current state). The bubble
   now closes itself on a touch or pen tap without passing the tap's click
   to the control underneath. The title's touch toggle still works (spec
   steps 1–2, unit tests for touch and pen).
2. **Done (2026-10-27): decide whether to run this spec under WebKit in CI.**
   Yes: `.github/workflows/ci.yml` (`mobile-shell-browser`, matrix
   `[chromium, webkit]`) runs `e2e/MobileAppShellLayout.spec.ts` in both
   engines. See decision 7, which replaces decision 3.

### Qualification

- **Open: iOS run before and after the fix.** A run on an iOS 26.5
  Simulator (Xcode 27) is recorded in Current state. Before: a bubble tap
  left the tooltip open and a tap below it closed it. After: both close it.
  A repeat on 2026-10-29 was not possible here (decision 8). Close this item
  once that record is accepted, or after a repeat on a Mac where `xcrun
  simctl list` responds.

## Constraints and rationale

- The tooltip is the only way to read a truncated title by touch, so it has to
  open and close on touch alone, with no hover.
- Dismissing the bubble must not also activate what is under it. On a phone
  the bubble covers the top of the workspace (tab and agent controls in the
  real app).

## Assumptions and decisions

### 1. Task 1: Diagnose from event traces, not from the guessed cause (2026-10-27)

A temporary spec logged every pointer, touch, mouse and focus event with
the target, the title's `aria-expanded` and the tooltip's `data-state`.
WebKit, bubble tap: `pointerdown`, `touchstart`, `pointerup` and
`touchend` targeted the tooltip content; `mousedown`, `mouseup` and
`click` went to the "Workspace" `div` under it. The tooltip stayed open,
and the title was never focused (`activeElement` was `BODY` throughout).
Chromium, same tap: everything went to the tooltip until `mousedown`,
then `focusout` from the title closed it. True outside tap (y 400) in
both engines: closed at `pointerdown`. The layer is
`@radix-ui/react-dismissable-layer` 1.2.1 under `react-tooltip` 1.4.1,
which does not pass `deferPointerDownOutside`. So the todo's guess (wait
for the `click`) did not apply, and closing on the outside `pointerdown`
would have changed nothing.

### 2. Task 1: Close from the bubble's `touchend`, not its `pointerdown` (2026-10-27)

Options: (a) close on a touch or pen `pointerdown` on the
bubble; (b) close on `touchend` and cancel it, with a pen-only click
handler; (c) make the bubble `pointer-events: none` so taps reach what
is underneath; (d) put the handlers in the shared `TooltipContent`.
Chose (b), local to the title. A trial of (a) closed the tooltip, but
React unmounted the bubble before the tap ended. `touchend` then went
to a detached node, and the click landed on the `<main>` underneath in
both WebKit and Chromium. With (b) the bubble is still mounted when
`touchend` fires, and cancelling it suppresses the mouse events and
click in both engines (traced) and on iOS (the counter button stayed at
0). (c) would turn every dismissing tap into a tap on the workspace. (d)
would change every tooltip in the app, while this is the only one that
opens on touch. Pros: closes in every engine without relying on focus,
and the dismissing tap has no side effects. Cons: a touch that starts
on the bubble and turns into a scroll also closes it (Radix already
closes tooltips when an ancestor of the trigger scrolls). The pen path
relies on the click event carrying `pointerType`, which Chromium and
WebKit both set. The touchend click suppression was traced in
Playwright's engines; on iOS it was only shown not to click through.

### 3. Task 2: Superseded by decision 7. Keep the WebKit run opt-in, guarded in CI by the unit test (2026-10-27)

Options: (a) add a CI job that installs Playwright WebKit
and runs this spec (or every mobile spec) under
`ORKESTRATOR_E2E_BROWSER=webkit`; (b) keep WebKit opt-in and add a
happy-dom regression test that CI already runs; (c) both. Chose (b). CI
runs `mise run test:full`, which does not include the Playwright
component suite at all, not even in Chromium. A WebKit job would be the
first browser job and would download WebKit and its Linux dependencies
on every run. Linux WebKit is also a different port from Safari, and
even macOS Playwright WebKit differed from iOS here (it sent the
bubble tap's click to the element underneath before the fix; iOS did
not). The unit test fails without the fix and checks the exact contract
(a cancelled `touchend` closes the tooltip). Pros: no new CI cost, and
the regression is still caught. Cons: other WebKit-only behaviour is
still found only by opt-in runs; the testing guide's "Other browser
engines" section says how to run them.

### 4. Task 3: Simulator, not a phone (2026-10-27)

The item allowed a device or a
simulator. Options: a physical iPhone (none attached to this Mac), the
iOS app in the simulator (`mise run dev:ios`, needs a running backend
profile), or Safari in the simulator against the component fixture
server. Chose the last: the fixture renders the same
`MobileAppShellLayout`, needs no backend and touches no real data. Taps
went through Device Hub (Xcode 27's simulator window), which delivers
them to the simulator as touches. Con: it does not exercise `WKWebView`
in the iOS app; the tooltip code is the same in both.

### 5. Task 1: keep the #1322 fix, not the Task analysis's document listener (2026-10-29)

The Task analysis was written after #1322 had merged, but it describes the
code before the fix (its line references point at the old layout). Its
recommended fix, a document `touchstart` or `pointerdown` listener in
`MobileAppShellLayout` that runs while the tooltip is open, would not have
helped. I traced the events on `main` at `79f3bc97` with a temporary spec (not
committed) in Playwright WebKit and Chromium. A true outside tap (y 600) already
closes the tooltip at `pointerdown` in both engines, through Radix's
`DismissableLayer`. The tap that failed was on the bubble, where `pointerdown`,
`touchstart`, `pointerup` and `touchend` all target the tooltip content, so an
outside listener never fires. The existing fix keeps the analysis's preferred
scope (local to `MobileAppShellLayout`, not the shared `tooltip.tsx`). It sits
on the bubble itself: `onTouchEnd` at
`apps/web/src/components/layout/MobileAppShellLayout.tsx:321`. With it, the
trace shows the bubble tap ending at `touchend`, with no `mousedown`,
`mouseup` or `click` after it. No code change was needed.

### 6. Task 1: prove the fix is load-bearing in WebKit (2026-10-29)

Following the recommended "instrument the run" approach, I removed the
bubble's `onTouchEnd` handler locally and ran the spec in WebKit. Two
`mobile-chromium` cases failed with the bubble still open: "long mobile titles
… touch and keyboard dismissal" and "touch dismissal suppresses compatibility
mouse events …". I restored the handler, and the full spec passed in WebKit
three times over (`--repeat-each 3`: 12 passed, 24 skipped) and once in
Chromium (6 passed, 6 skipped). The skipped cases are gated by project or
engine.

### 7. Task 2: CI runs this spec under WebKit, as recommended (2026-10-29)

The recommended option, running only `e2e/MobileAppShellLayout.spec.ts`
under WebKit in CI, is already in place. #1322 added the
`mobile-shell-browser` job to `.github/workflows/ci.yml`. It installs each
browser with `bunx playwright install --with-deps` and runs the spec with
`ORKESTRATOR_E2E_BROWSER` set to `chromium` and then `webkit`. The
`desktop-chromium` cases that the spec skips cost nothing, so restricting the
job to the `mobile-chromium` project would save no time. Decision 3 ("keep it
opt-in") no longer describes the repository, and the testing guide's "Other
browser engines" section already matches the CI job. No change needed.

### 8. Task 3: left open; the simulator did not respond on this Mac (2026-10-29)

This Mac has Xcode 26.6 and iOS simulator runtimes (17.5, 18.2 and 26.2), but
`xcrun simctl list` hung and was killed after 60 s and then 170 s, both inside
and outside the sandbox, and CoreSimulatorService never started. Per the
brief, nothing was installed and no device was used. The 2026-10-27 iOS
record names Xcode 27 and iOS 26.5, neither of which is installed here, so it
was probably made on a different Mac and cannot be repeated from this one. I
left the task open rather than marking it done from a record I could not
reproduce.

## Open questions

- None. iOS Safari behaves like Playwright's WebKit for the tooltip itself
  (decision 4); the two differ only in where the bubble tap's mouse events
  went before the fix (decision 3).

## Needs verification

- Task 3: accept the 2026-10-27 iOS 26.5 Simulator record, or repeat it on
  a Mac where `xcrun simctl list` responds (decision 8). Otherwise none for
  this file. A run on a physical phone and in the `WKWebView` iOS
  app is covered by 0035's still-open iOS item, which exercises the same
  shell.

## Related

- [0035-mobile-layout-gaps.md](0035-mobile-layout-gaps.md): the WebKit run
  that found this, and the open real-phone run of the mobile shell.
- [0031-live-provider-and-platform-qualification.md](0031-live-provider-and-platform-qualification.md):
  Safari and iOS runs.

## Replaces

Nothing; this was newly found.
