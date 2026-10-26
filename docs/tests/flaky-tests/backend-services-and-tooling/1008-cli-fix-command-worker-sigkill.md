# CLI `fix-command.test.ts`: the test worker is SIGKILLed

- **ID:** 1008
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** the whole file `packages/cli/tests/fix-command.test.ts` (reported as `✗ tests/fix-command.test.ts (worker crashed: SIGKILL)`; no single test named)
- **Owning file:** `packages/cli/tests/fix-command.test.ts`
- **Original command:** `mise run test` on branch `todo-0033-remote-host-upgrades-e94b3d6c2a08` rebased onto `a51045a4`, Bun 1.4.4 on Arch Linux x64 (omarchy-hp), default reservations, host load average 21–25 with other worktrees running suites. The branch does not touch `fix` or its tests.
- **Failure:** the Bun worker running the file was killed with SIGKILL; the CLI package reported 295 passed, 2 skipped, 1 failed. No user-slice OOM line was logged after 09:50 UTC; the kernel log was not readable without root.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts --parallel=2 tests/fix-command.test.ts` from `packages/cli`: 32 passed.
- **Evidence:** `/tmp/orkestrator-test-run.XMCWCR/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` on omarchy-hp.
- **Hypothesis:** memory pressure or the runner's own kill under heavy host load. Related timeouts in the same file: 0746, 0765.
