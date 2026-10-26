# CLI local-lifecycle scenario: the backend's stop returns null

- **ID:** 1007
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `packaged client against a real backend > scenario: local-lifecycle`
- **Owning file:** `packages/cli/tests/cli-client.test.ts:213`
- **Original command:** `mise run test` on branch `todo-0033-remote-host-upgrades-e94b3d6c2a08` (base `93018933`), Bun 1.4.4 on Arch Linux x64 (omarchy-hp), host load average 15–17 with other worktrees running suites. The branch changes one human line of `host status` in the CLI, which this scenario does not read.
- **Failure:** after 2,997.52 ms, in the scenario's `finally`: `expect(await backend.stop()).toBe(0)` received `null` (the backend process ended without an exit code, i.e. by signal or before the stop recorded one). Just before it the log shows "Recording failed; relay requests are refused. The recording is incomplete." from another scenario.
- **Suite counts:** CLI package 322 passed, 2 skipped, 1 failed across 325 tests in 30 files (31.57 s).
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts --parallel=2 tests/cli-client.test.ts` from `packages/cli`: 9 passed.
- **Evidence:** `/tmp/orkestrator-test-run.s0jA9M/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` on omarchy-hp.
- **Hypothesis:** under load the test backend exits by signal (or the stop's deadline escalates to a kill) so no exit code is recorded. Not confirmed.
