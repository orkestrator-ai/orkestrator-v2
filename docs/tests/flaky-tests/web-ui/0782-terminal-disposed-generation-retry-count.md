# useTerminal reconnect behavior > cancels a queued reconciliation retry when the connection generation is disposed

- **ID:** 0782
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `useTerminal reconnect behavior > cancels a queued reconciliation retry when the connection generation is disposed`
- **Owning file:** `apps/web/src/hooks/useTerminal.test.tsx`
- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=a5d78cfcd54907a13973463d4bd08497fd025c90 mise run test:logged -- --name merge-tests -- mise run test`, with the GNU shell-tool PATH from the testing guide.
- **Worker configuration:** aggregate workspace group, two package tasks with two Bun workers per package; other worktrees were validating on the same host.
- **Failure:** Expected three getTerminalOutputSnapshot calls, received five at line 2206 (283.75 ms).
- **Suite counts:** web package: 9,347 passed, 10 skipped, 5 failed across 594 files in 1,067.34 s.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.8ZKWYk/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-0043-rerun-terminal -- bun test --cwd apps/web ./src/hooks/useTerminal.test.tsx --parallel=1 --only-failures` passed unchanged (exit 0, 5.1 s).
- **Hypothesis:** timing sensitivity under concurrent host load; the complete unchanged owning file passed with one worker. No root cause has been established. No assertion, deadline, or skip was changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** after `waitFor(... toHaveBeenCalledTimes(3))` (`useTerminal.test.tsx:2200`), the retry loop keeps running until `disconnect()`. Under load, two more snapshot reads landed first.
- **Next step:** control the retry timer (fake timers or an injected delay) so the count at disconnect is fixed.
