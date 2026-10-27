# Mobile title tooltip stays open after an outside tap in WebKit

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
   No; it stays opt-in. See decision 3.

### Qualification

- **Done (2026-10-27): iOS run before and after the fix.** iOS 26.5
  Simulator, recorded in Current state. Before: a bubble tap left the
  tooltip open and a tap below it closed it. After: both close it.

## Constraints and rationale

- The tooltip is the only way to read a truncated title by touch, so it has to
  open and close on touch alone, with no hover.
- Dismissing the bubble must not also activate what is under it. On a phone
  the bubble covers the top of the workspace (tab and agent controls in the
  real app).

## Assumptions and decisions

1. **Diagnose from event traces, not from the guessed cause (2026-10-27).**
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
2. **Close from the bubble's `touchend`, not its `pointerdown`
   (2026-10-27).** Options: (a) close on a touch or pen `pointerdown` on the
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
3. **Keep the WebKit run opt-in, guarded in CI by the unit test
   (2026-10-27).** Options: (a) add a CI job that installs Playwright WebKit
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
4. **Simulator, not a phone (2026-10-27).** The item allowed a device or a
   simulator. Options: a physical iPhone (none attached to this Mac), the
   iOS app in the simulator (`mise run dev:ios`, needs a running backend
   profile), or Safari in the simulator against the component fixture
   server. Chose the last: the fixture renders the same
   `MobileAppShellLayout`, needs no backend and touches no real data. Taps
   went through Device Hub (Xcode 27's simulator window), which delivers
   them to the simulator as touches. Con: it does not exercise `WKWebView`
   in the iOS app; the tooltip code is the same in both.

## Open questions

- None. iOS Safari behaves like Playwright's WebKit for the tooltip itself
  (decision 4); the two differ only in where the bubble tap's mouse events
  went before the fix (decision 3).

## Needs verification

- None for this file. A run on a physical phone and in the `WKWebView` iOS
  app is covered by 0035's still-open iOS item, which exercises the same
  shell.

## Related

- [0035-mobile-layout-gaps.md](0035-mobile-layout-gaps.md): the WebKit run
  that found this, and the open real-phone run of the mobile shell.
- [0031-live-provider-and-platform-qualification.md](0031-live-provider-and-platform-qualification.md):
  Safari and iOS runs.

## Replaces

Nothing; this was newly found.
