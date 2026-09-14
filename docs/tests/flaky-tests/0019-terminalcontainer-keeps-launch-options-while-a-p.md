# `TerminalContainer > keeps launch options while a pending native launch is still outstanding` (`apps/web/src/components/terminal/TerminalContainer.view.test.tsx:6643`)

- **ID:** 0019
- **Status:** open
- **Date observed:** 2026-08-29
- **Original command:** `bun run test`
- **Worker configuration:** the web workspace ran its parallel package suite
  while the root, bridge, build, and protocol work from `scripts/test-all.ts`
  shared the host.
- **Failure:** the case exceeded its 12-second outer budget after the aggregate
  runner reported 384,624.67 ms; a trailing assertion then observed the pending
  launch already cleared.
- **Suite counts:** web workspace reported 5,577 passed, 1 skipped, 3 failed,
  and 1 trailing error across 5,581 tests.
- **Isolated rerun:** `bun test src/components/terminal/TerminalContainer.view.test.tsx`
  from `apps/web` passed 126/126 in 10.19 s; the affected 3.5-second timer case
  passed in 3,505.35 ms.
- **Hypothesis:** the case deliberately waits 3.5 seconds against real timers.
  Its isolated duration matches that wait, while the aggregate reported more
  than six minutes and also timed out unrelated focus and bridge tests. This
  supports runner/host starvation rather than a launch-state regression.
