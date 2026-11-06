# useTerminal reconnect behavior > cancels a queued reconciliation retry when the connection generation is disposed

- **ID:** 0782
- **Status:** resolved
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

### Resolution — 2026-11-06

**Root cause.** The triage above was right. Once the backend keeps answering an
older revision, the hook queues a reconciliation retry every
`TERMINAL_RECONCILE_RETRY_MS` (100 ms). The test waited for exactly three
snapshot reads, disconnected, then asserted the count was still three. If
`waitFor` observed three more than 100 ms before `disconnect()` ran, as on a
loaded host, a retry had already run (5 reads), even though disposal correctly
stopped every later retry.

**Reproduction.** Inserting a 130 ms wait after the `waitFor` in a copy of the
unchanged owner reproduced the exact failure (expected 3 calls, received 5).

**Fix.** `apps/web/src/hooks/useTerminal.test.tsx`: the test records the read
count at disposal and asserts that no read happens in the 150 ms after
`disconnect()`, longer than the retry delay. That is the property under test:
a queued retry does not survive disposal.

**Verification.** The delayed copy passes with the fix. Then
`mise run test:logged -- --name web-0782-owner -- bun --cwd=apps/web test src/hooks/useTerminal.test.tsx`
passed (exit 0), and
`mise run test:logged -- --name web-0782-stress -- bun --cwd=apps/web test src/hooks/useTerminal.test.tsx -t "reconnect behavior" --rerun-each=20`
passed (exit 0, 26.3 s).
