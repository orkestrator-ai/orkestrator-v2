# EnvironmentItem copy-address tooltip stalls in the aggregate

- **ID:** 9874
- **Status:** resolved
- **Date observed:** 2026-10-22
- **Test:** `EnvironmentItem copy address > clicking localhost address in tooltip copies to clipboard`
- **Owning file:** `tests/unit/components/EnvironmentItem.test.tsx`
- **Original command:** `mise run test:logged -- --name recurring-full-suite -- mise run test`
- **Worker configuration:** default aggregate workspace/root/bridges/protocol groups; root group reserves one worker on this host.
- **Failure:** tooltip text never contained `Created:`; reported test duration 987490.90 ms. The root group's no-progress watchdog also fired after 300000 ms without output. Aggregate exited 1 after 1095.2 seconds; workspace independently stalled in the Chromium executable-document policy test. Complete root counts were unavailable because the group was terminated.
- **Isolated rerun:** `mise run test:logged -- --name environment-item-isolated -- bun test ./tests/unit/components/EnvironmentItem.test.tsx --parallel=1 --only-failures` passed the complete unchanged owning file (exit 0, 4.5 seconds logged).
- **Evidence:** `orkestrator-test-run.GB1K1o/recurring-full-suite.log.gz` and the inner aggregate's `orkestrator-test-run.IGYJrv` below the host temporary directory.
- **Hypothesis:** delayed timers or host scheduling are plausible given the simultaneous long stalls in independent groups; no specific cause is established. No tooltip implementation, assertion, timeout or skip changed.

- **Aggregate retry:** `mise run test:logged -- --name recurring-full-suite-final -- mise run test` passed every non-iOS group (exit 0, 437.1 seconds logged), without changing either failing owner. The flake remains open because the underlying cause has not been fixed.

## Resolution (2026-11-10)

- **Root cause:** a wall-clock race in the test helper. `showTooltip` hovered
  the row and then polled with `waitFor` (one-second deadline) for the
  tooltip, which `useHoverTooltip` opens after a real 500 ms timer. When the
  process stalled for longer than the remaining margin, the open timer and
  `waitFor`'s deadline timer expired in the same timer batch: the open timer
  only scheduled React's render, and the deadline fired before that render
  committed, so the tooltip "never contained `Created:`". The recorded failure
  happened during an aggregate-wide watchdog stall.
- **Fix:** `tests/unit/components/EnvironmentItem.test.tsx` now advances the
  hover delay explicitly with Bun's fake timers around the hover
  (`jest.advanceTimersByTime(HOVER_TOOLTIP_OPEN_DELAY_MS)` inside `act`) and
  asserts the tooltip synchronously. `apps/web/src/components/ui/hover-tooltip.tsx`
  exports the delay as `HOVER_TOOLTIP_OPEN_DELAY_MS` (still the hook's
  default, 500 ms) so the test cannot drift from it. No assertion changed.
- **Reproduced:** yes — a temporary `Bun.sleepSync(1100)` on the first
  `waitFor` poll made all eight tooltip cases in the file fail
  (`mise run test:logged -- --name repro-9874 -- bun test ./tests/unit/components/EnvironmentItem.test.tsx --parallel=1`:
  78 pass, 8 fail, each about 1,120 ms). With the fix and the same 1.1 s stall
  between the hover and the timer advance, the file passed
  (`--name fix-9874-stall`, exit 0).
- **Stress:** `mise run test:logged -- --name stress-9874 -- bun scripts/test-under-contention.ts -- bun test ./tests/unit/components/EnvironmentItem.test.tsx --parallel=1 --rerun-each=20`
  passed (exit 0, 41.4 s).
