# Mobile title tooltip stays open after an outside tap in WebKit

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Find and fix the WebKit outside-tap dismissal**: an outside touch tap leaves the title tooltip open in Playwright's WebKit. Status: open.
2. **Decide whether CI runs the spec under WebKit**: the spec is opt-in under WebKit today. Status: open (depends on 1).
3. **Qualify on iOS Safari**: tap the title, then the workspace, on a device or simulator, before and after the fix. Status: open (needs a Mac with Xcode; batched with [0031](0031-live-provider-and-platform-qualification.md)).

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
