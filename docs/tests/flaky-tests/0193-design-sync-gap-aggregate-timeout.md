# Design sync gap test times out in the aggregate

- **ID:** 0193
- **Status:** open
- **Date observed:** 2026-10-12
- **Test:** `design incremental sync > gaps reset: expired range, future cursor and a new generation`
- **File:** `apps/backend/src/core/design/sync.test.ts`
- **Original command:** `mise run test:logged -- --name final-messaging-full-suite -- mise run test`, with the macOS GNU-tool PATH from the testing guide.
- **Worker configuration:** Backend package one Bun worker; workspace and bridges at most two package tasks; root group three workers; protocol one slot. Another aggregate run was completing on the same host under the shared capacity scheduler.
- **Failure:** Five-second test timeout at 5013.03 ms, followed by `DesignError: Design service is stopping` during fixture teardown.
- **Backend counts:** 5787 passed, 15 skipped, two failures across 323 files in 260.21 seconds. The other failure was the mail ambiguity regression corrected in this change.
- **Isolated rerun:** `mise run test:logged -- --name design-sync-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design/sync.test.ts --parallel=1 --only-failures` passed in 1.1 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.VmCKDu/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

Host contention is a plausible explanation for the aggregate timeout; the isolated
pass does not establish the cause. The teardown error follows the timeout and
fixture shutdown. No test was skipped, loosened, or changed to conceal the failure.
