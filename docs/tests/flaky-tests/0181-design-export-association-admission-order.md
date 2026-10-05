# Design export association fault and destination admission order

- **ID:** 0181
- **Status:** resolved
- **Date observed:** 2026-10-04
- **Snapshot:** based on `6392d650`, with the design library and host-file import fixes staged.
- **Test:** `design exports to a repository worktree > an association failure retires the created canvas before queued opens retry`, in `apps/backend/src/core/design-exports.test.ts`.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`, with the GNU-tool PATH prescribed in `docs/development/testing-guide.md`.
- **Worker configuration:** workspace group used Turbo concurrency 2 with one isolated Bun worker per package; root group 3 workers, bridges 2 and protocol 1.
- **Failure:** the first result was `fulfilled` where line 449 expected `rejected` (5.12 ms).
- **Suite result:** backend 5,661 passed, 15 skipped and 1 failed across 318 files (248.24 seconds). Root also failed the deterministic DOM-diagnostic assertion introduced by this change; that assertion was corrected separately. Bridges and protocol passed. The aggregate exited 1 after 391.0 seconds.
- **Isolated rerun:** `mise run test:logged -- --name design-exports-repro -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design-exports.test.ts --parallel=1 --only-failures` passed in 0.3 seconds.
- **Evidence:** `orkestrator-test-run.bEigIa/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer wrapper `orkestrator-test-run.rY1aIN`.
- **Cause:** local destination admission awaits `realpath` and `lstat` before entering the lock in `withDesignExportDestinationLock`. Concurrent call order therefore does not guarantee admission order. The test also counted every private-record write instead of targeting association persistence. Targeting only the association write still reproduced the first-result mismatch in 3 of 20 stress repetitions, confirming that fault targeting alone did not establish order.
- **Fix:** arm the filesystem fault only for the imported canvas's association record, hold that write, and then start the retry. Preserve the ordered rejection/success assertions and additionally verify the exact injected error, the surviving canvas's distinct identity and removal of the failed private record.
- **Verification:** `mise run test:logged -- --name design-export-stress -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design-exports.test.ts ./src/core/commands-registry-design.test.ts ./src/core/design-host-file.test.ts --parallel=2 --rerun-each=20 --only-failures` passed in 3.5 seconds. No test was skipped or loosened.
