# Preview retention scheduled reconcile count varies under aggregate load

- **ID:** 0694
- **Status:** open
- **Date observed:** 2026-10-23
- **Test:** `PreviewPartitionRetention > a scheduled reconcile stops once its transport closes`
- **Owning file:** `apps/desktop/tests/preview-partition-retention.test.ts:454`
- **Original command:** `mise run test:logged -- --name draft-fix-suite -- mise run test`, while validating shared creation-dialog draft restoration (`7a667390d`).
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1; workspace package concurrency two, with two Bun workers per desktop package run. Other worktrees also occupied the shared host queue.
- **Failure:** the test expected at least two reconciliations after `Bun.sleep(40)`, with five-millisecond initial and recurring delays, but observed one. The failed case took 108.53 ms.
- **Suite counts:** desktop reported 1,197 passed, 14 skipped and one failed across 1,212 tests in 85 files (34.24 s).
- **Isolated rerun:** `mise run test:logged -- --name draft-fix-rerun-preview-retention -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/preview-partition-retention.test.ts --parallel=1 --only-failures` passed the complete unchanged owning file, exit 0 in 0.5 seconds logged.
- **Evidence:** `orkestrator-test-run.x5x58l/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.NEAVB6/draft-fix-suite.log.gz` under the host temporary directory after aggregate finalization.
- **Assessment:** the isolated pass establishes an intermittent failure. Event-loop or host contention is plausible, but its cause remains unconfirmed. No preview implementation, assertion, delay, timeout or skip was changed.
