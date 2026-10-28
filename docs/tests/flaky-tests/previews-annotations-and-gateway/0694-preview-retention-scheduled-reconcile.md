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
- **Evidence:** `orkestrator-test-run.x5x58l/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.NEAVB6/draft-fix-suite.log.gz` under the host temporary directory. The outer logger reached its 30-minute deadline before backend completion; the child log was compressed after its watchdog stopped the process tree.
- **Assessment:** the isolated pass establishes an intermittent failure. Event-loop or host contention is plausible, but its cause remains unconfirmed. No preview implementation, assertion, delay, timeout or skip was changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** recurred on 2026-10-25 in [0815](../aggregate-validation-runs/0815-container-rebuild-state-validation.md) (load 54 to 65). The owner passed alone there and today (18/18, 0.2 s; Bun 1.4.4). The test still expects at least two runs of 5 ms timers after a fixed `Bun.sleep(40)` (`preview-partition-retention.test.ts:463`).
- **Next step:** poll (bounded) until two runs are seen, then close the transport and check that no further run happens.

## Pending rename review — 2026-10-28

Preparation's `mise run test` repeated the expected-at-least-two/received-one failure (41.76 ms). Evidence: `.orkestrator/review-artifacts/review-validation-fabbd29e-2cbf-4f6a-94fa-442f4bb48d78/validation-07.stdout.txt`. The complete unchanged owner passed with `mise run test:logged -- --name recorded-desktop-failure-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/preview-partition-retention.test.ts --parallel=1 --only-failures` (exit 0, 0.5 s). No preview implementation, assertion, delay, timeout or skip changed.
