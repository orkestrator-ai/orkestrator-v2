# Mobile title tooltip stays open after an outside tap in WebKit

Found on 2026-10-26 while qualifying
[0035-mobile-layout-gaps.md](0035-mobile-layout-gaps.md) in Playwright's
WebKit, against `main` at `93018933`.

On a phone the shell's title truncates. Tapping it opens a tooltip with the
whole title (`MobileAppShellLayout`, a controlled Radix `Tooltip` driven by
`titleTooltipOpen`), and tapping anywhere else should close it. In Chromium it
closes. In WebKit it stays open.

## Current state

- `e2e/MobileAppShellLayout.spec.ts`, "long mobile titles stay between
  controls and support touch and keyboard dismissal", fails at line 86 in the
  `mobile-chromium` project (390 × 844, touch) when run with
  `ORKESTRATOR_E2E_BROWSER=webkit` (Playwright WebKit 27.2). After a touch tap
  on the non-interactive "Workspace" text, the tooltip is still there:
  `expect(page.getByRole("tooltip")).toHaveCount(0)` received 1. It failed on
  all four runs: three with 0035's branch and one with `main`'s
  `MobileAppShellLayout.tsx` swapped in, so 0035's changes did not cause it.
- The earlier steps in that test pass in WebKit: tapping the title opens the
  tooltip and tapping it again closes it.
- Chromium, the engine CI runs, passes the whole test.
- Not checked yet: iOS Safari on a device or simulator. Playwright's WebKit
  runs on the macOS host with emulated touch, so it may not match iOS here.

## Outstanding work

### Code

1. Find out why an outside tap does not close the tooltip in WebKit. A likely
   cause: Radix's `DismissableLayer` does not dismiss a touch `pointerdown`
   outside until the `click` that follows it, and WebKit may not send that
   `click` for a tap on non-interactive content. If that is the cause, close
   the tooltip from the outside `pointerdown` for touch input. Keep the
   existing touch toggle on the title working.
2. Once WebKit passes, decide whether to run this spec under WebKit in CI. It
   is opt-in today.

### Qualification

- On an iOS device or simulator, open the shell at phone width, tap the
  truncated title, then tap the workspace. Record whether the tooltip closes,
  before and after the fix.

## Constraints and rationale

- The tooltip is the only way to read a truncated title by touch, so it has to
  open and close on touch alone, with no hover.

## Open questions

- Does iOS Safari behave like Playwright's WebKit here?

## Related

- [0035-mobile-layout-gaps.md](0035-mobile-layout-gaps.md): the WebKit run
  that found this.
- [0031-live-provider-and-platform-qualification.md](0031-live-provider-and-platform-qualification.md):
  Safari and iOS runs.

## Replaces

Nothing; this was newly found.
