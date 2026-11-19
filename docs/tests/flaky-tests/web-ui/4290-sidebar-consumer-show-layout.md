# Sidebar consumer show layout count

- **ID:** 4290
- **Status:** resolved
- **Date observed:** 2026-11-04
- **Tests:** `the sidebar’s animated width lays out a real terminal and editor at most twice`
- **File:** `e2e/agent-testing/sidebar-width-consumers.spec.ts`

Original command: `ORKESTRATOR_AGENT_TEST_PROFILE=agent-sidebar-round3 mise run test:logged -- --name sidebar-real-consumers -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/sidebar-width-consumers.spec.ts --workers=1`.
One worker, 0 passed / 1 failed in 29.2 seconds. The show transition reported
three terminal widths where at most two were expected. Evidence:
`/tmp/orkestrator-test-run.ndFA5o/sidebar-real-consumers.log.gz`.

The unchanged owning-file rerun with the identical command passed 1 / 1 in
31.0 seconds. Assertions were not relaxed.

## Root cause

Not a flake. A hidden sidebar has no resize handle: the shell mounts it when
the sidebar starts to show and unmounts it when hiding settles. The motion pin
held the main column at its measured width and ignored the handle, so showing
laid the column out once more when the handle took its pixel, and hiding laid
it out once more when the handle went. Whether the extra layout reached the
terminal depended on frame timing, which is why the rerun passed.

## Fix

`sidebarMotionPins` takes the handle's width when a change mounts or unmounts
it, and `useSidebarPanelMotion` passes it for changes to or from hidden. The
fixture now mounts its handle as the shell does. `e2e/SidebarMotion.spec.ts`
asserts one main-content layout for hidden→full and compact→full (with frames
on time and 300 ms late) and for hiding; with the handle width ignored, the
hidden→full and hiding cases fail, and with the fix all 12 cases pass.
`useSidebarPanelMotion.test.tsx` covers the three pin cases.

## Recurrence (2026-11-13, reopened)

Base `17d28238c` contains fix `9dcdcee6e3`, and `mise run flaky:recurrence -- 4290`
said reopen. The branch was `remove-dead-bridge-be98778b92d1-r1` at `98ff78d0f`,
which changes no sidebar or motion code. The symptom is new: during
`mise run test:agent:browser:isolated`, at load about 40,
`expect(steps.size).toBeGreaterThan(3)` at line 245 received `2`. The panel was
sampled at only two distinct widths, which is consistent with a renderer too
loaded to paint intermediate frames. It is not the layout over-count that was
fixed. The unchanged owner case
(`bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/sidebar-width-consumers.spec.ts:119 --workers=1`
against a fresh `--fixture --headless` profile at load about 7) passed
(19.6 s). No assertion was changed.

## Triage note (2026-11-15)

Not changed. The owner is an `e2e/agent-testing` spec run through `playwright.browser.config.ts`, which this pass left alone because the config is shared with other groups' specs (a global assertion budget could loosen latency checks they rely on); no safe spec-local signal was identified without a live agent-testing profile. Stays `open`; Playwright agent-testing suites were not run.

## Triage note (2026-11-15, after the config change)

Follow-up: `playwright.browser.config.ts` now sets `expect: { timeout: 30_000 }` (its `timeout: 120_000` was already in place), but this case stays `open`: both recorded failures are value mismatches in layout sampling, not expired waits.

## Resolution — 2026-11-19

Reproduced on demand against a fresh `dev:test --fixture --headless` profile
(`fork-c-sidebar`, reset afterwards) by throttling the renderer with CDP
`Emulation.setCPUThrottlingRate` at rate 20, a temporary hook in the spec.
Diagnostics logged the sampled sidebar widths, the panel's own `transition*`
events and each consumer's layouts. Two separate causes showed up.

1. **Recorded symptom (two sampled widths): the test.** Under throttling every
   change sampled only its start and end widths (`[380,56]`, `[56,380]`,
   `[380,0]`), the recorded `steps.size` of 2. In every case the browser
   still ran the panel's `flex-grow` transition to its end
   (`transitionend`, `elapsedTime` 0.18). Sampling with
   `requestAnimationFrame` measures how many frames a loaded renderer paints
   in 180 ms, not whether the width animated.
   **Fix:** the spec records the sidebar panel's `transitionrun`,
   `transitionend` and `transitioncancel` events, waits for the last one to
   be a `transitionend` (the browser can dispatch it after the width has
   settled), and asserts that the last `flex-grow` event is a
   `transitionend` after `SIDEBAR_WIDTH_TRANSITION_MS`. A temporary
   `[data-panel] { transition: none !important }` style made the new check
   fail (the transition never ended), so it still catches a jump.
2. **Product bug: the show could lay content out mid-motion.** With the frame
   count no longer failing, the same throttled run failed the show-from-hidden
   change with 3 layouts instead of at most 2: the terminal at 594.6 px, then
   529 px, and three PTY resizes (66, 58 and 58 columns). `useSidebarPanelMotion`
   released the pins on a timer started at the React commit
   (`SIDEBAR_SETTLE_MS`, 220 ms). A change to `full` applies its width a frame
   later (`panelRef.resize` in the restore frame), so on a loaded renderer the
   transition started late and the timer released the pins while the panel
   was still moving. This is the original 2026-11-04 symptom, three terminal
   widths on show, by a different route than the handle-width fix.
   **Fix:** when the settle timer fires, the hook now waits for the frame that
   applies the `full` width if it has not run (and arms the timer again from
   there), and for any unfinished `flex-grow` transition on the sidebar panel
   (`getAnimations()`, then `finished`). A generation counter keeps a deferred
   release from settling a later change. Unit cases in
   `useSidebarPanelMotion.test.tsx` cover both waits and the generation
   check; the first two fail on the previous hook.

Verification (same profile):

- Before the fixes, rate 20: two sampled widths per change (the recorded
  symptom); with only the spec fix, `Expected: <= 2, Received: 3` on the show
  change.
- Both fixes, rate 20: show-from-hidden laid the terminal out once (529 px)
  with two PTY resizes. The strict spec passed
  `--repeat-each=3` (`sidebar-fixed-cpu20`, 206.4 s).
- Both fixes, no throttling: `--repeat-each=3` passed (`sidebar-fixed-plain`,
  75.9 s). The baseline before any change passed once (20.6 s).
- `bun test --cwd apps/web ./src/components/layout/useSidebarPanelMotion.test.tsx`:
  23 pass. `e2e/SidebarMotion.spec.ts` (component fixture, two workers)
  passed. Web and e2e typechecks passed.

A viewport resize can replace the transition within the
same mode change. The hook now checks for a live replacement after completion
or cancellation. It stops checking when a drag releases the pins explicitly
or a later mode change supersedes the wait. The same-generation regression
failed on the previous hook and passed with the fix. Focused tests also cover
cancellation without a replacement and manual release during either wait.
The Chromium fixture resized the viewport from 1024 px to 390 px during
the wait and verified that the content stayed pinned until the replacement
ended. The real-stack terminal and editor spec passed on an isolated profile.
