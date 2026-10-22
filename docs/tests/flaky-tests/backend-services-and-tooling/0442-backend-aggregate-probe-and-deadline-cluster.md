# Backend aggregate capability probe, retaining close and startup deadline

- **ID:** 0442
- **Status:** open
- **Date observed:** 2026-10-18
- **Original command:** `mise run test:logged -- --name merge2-tests -- mise run test`, macOS arm64 and Bun 1.4.3, merging `c85ab60a` into `9467f965`; workspace/root/bridges/protocol reservations 4/1/2/1 alongside component and isolated browser validation.
- **Aggregate counts:** backend 9081 passed, 41 skipped and 11 failed across 9133 tests in 485 files (1118.57 seconds); the full command exited 1 after 1132.1 seconds. Other backend failures have their own cases. Every other workspace package passed.

| Owner | Failed test | Failure | Rerun |
| --- | --- | --- | --- |
| apps/backend/src/core/public-api/public-api-projects.test.ts | `public_action contract > capabilities reports the package version without launcher metadata` | 5000 ms timeout, 5003.78 ms observed | Owner passed unchanged in the four-file, one-worker `merge2-late-backend-owners` run; that run failed only the retaining-close owner (163 passed, one failed, 25.0 seconds logged). |
| apps/backend/src/core/commands-registry-teardown.test.ts | `tab close retains conversation history > a bridge close can finish after the legacy request budget` | Expected the teardown promise to resolve; it rejected (419.92 ms). | The four-file rerun repeated it (313.13 ms); the owning file alone then passed unchanged in 5.0 seconds. |
| apps/backend/tests/standalone-ready.test.ts | `waitForStandaloneBackendReady > times out with a named diagnostic without waiting for stdout to close` | Expected elapsed time below 200 ms; received 231.10 ms (232.12 ms case duration). | Owning file passed unchanged in 0.5 seconds. |

Commands:

- `mise run test:logged -- --name merge2-late-backend-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-skills.test.ts ./src/core/public-api/public-api-projects.test.ts ./tests/commands-registry-environments-status.test.ts ./src/core/commands-registry-teardown.test.ts --parallel=1 --only-failures`
- `mise run test:logged -- --name merge2-teardown-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-registry-teardown.test.ts --parallel=1 --only-failures`
- `mise run test:logged -- --name merge2-standalone-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/standalone-ready.test.ts --parallel=1 --only-failures`

Evidence: `orkestrator-test-run.0J1rem/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.ihuIVF/merge2-late-backend-owners.log.gz` below the host temporary directory. The unchanged rerun passes establish intermittence; shared-host scheduling/I/O contention remains a hypothesis. No implementation, assertion, timeout or skip changed.
