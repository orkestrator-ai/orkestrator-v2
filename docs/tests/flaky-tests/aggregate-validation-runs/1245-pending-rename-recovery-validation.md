# Pending rename recovery validation

- **ID:** 1245
- **Status:** open
- **Date observed:** 2026-10-28
- **Command:** `mise run test`, after commits `6566274cf` and `88f8b5c04`.
- **Host admission:** workspace/root waited about 1,410 seconds; protocol waited
  1,626 seconds and passed. Bridges never ran: the 1,800-second capacity wait
  expired. The aggregate exited 1 after 1,970 seconds.
- **Evidence:** `orkestrator-test-run.4SKTfO/summary.json`,
  `workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and
  `root-and-agent-support-tests.log.gz` under the host temporary directory.

| Owner | Aggregate failure | Complete unchanged owner rerun |
| --- | --- | --- |
| `tests/unit/disk-report.test.ts` | Isolated-checkout report timed out at 5,087 ms; subprocess status was null, with a between-test error. Recurrence of [0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md). | `mise run test:logged -- --name disk-report-failure-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` passed (5.2 s). |
| `apps/backend/src/core/storage-writer-guards.test.ts` | `name the store they write` timed out at 5,109 ms. Earlier aggregate observations appear in [1003](1003-legacy-migration-0058-validation.md). | `mise run test:logged -- --name workspace-failure-backend-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/storage-writer-guards.test.ts --parallel=1 --only-failures` passed (1.6 s). |
| `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` | Maximal-list filtering expected one projection read and observed two (2,036 ms). Recurrence of [0722](../native-agents-and-transcripts/0722-native-command-filter-projection-read.md). | Passed with the federation owner below (2.9 s total). |
| `apps/web/src/components/federation/node-action-requests.test.tsx` | Over-limit root-change approval timed out at 5,555 ms, followed by a missing-button error between tests. | `mise run test:logged -- --name workspace-failure-web-owners -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.commands.test.tsx ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures` passed (2.9 s). |

No implementation, assertion, wait, timeout or skip in these four owners changed.
Their isolated passes establish intermittent failures; the aggregate remains
non-green, and bridges remain unqualified by this run. Related rename tests and
backend static checks passed separately. The earlier preparation retention
timeout was reproduced alone and repaired by batching fixture inserts in one
transaction, without changing retention assertions.
