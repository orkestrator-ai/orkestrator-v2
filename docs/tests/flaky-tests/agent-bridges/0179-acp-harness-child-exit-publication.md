# ACP harness child exit publication

- **ID:** 0179
- **Status:** open
- **Date observed:** 2026-10-02
- **Original command:** `mise run test:logged -- --name steer-suite -- mise run test`
- **Worker configuration:** normal aggregate host allocation; bridge packages use their configured isolated workers. Browser validation also ran on the host.
- **Failure:** `ACP test harness child tracking > awaits and deregisters live and already-exited children before deleting fixtures` at `bridges/acp-bridge/src/acp-test-harness.test.ts:56` expected `live.exitCode` to be 0 after cleanup, but received null (38.43 ms).
- **Isolated rerun:** `mise run test:logged -- --name steer-acp-harness-isolation -- bun test ./bridges/acp-bridge/src/acp-test-harness.test.ts --parallel=1 --only-failures` passed in 0.1 seconds.
- **Evidence:** aggregate artifact `orkestrator-test-run.kPWByh/bridges.log.gz`; aggregate failed with this single bridge test failure. Workspace and protocol groups passed.
- **Hypothesis:** subprocess completion and publication of `exitCode` may race under aggregate load. The steering fixes do not change this harness or its child lifecycle. No test was skipped or loosened; the cause remains unconfirmed.

## Recurrence on 2026-10-16

The second `mise run test` on the OpenCode skew-guard branch (no bridge source
changed) failed this case the same way at line 56 (13.81 ms), while other
machine environments ran suites concurrently. The owning file passed alone with
`bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts
./src/acp-test-harness.test.ts` (1 passed). Evidence:
`/tmp/orkestrator-test-run.J2NQoU/bridges.log.gz`.

- **Recurrence 2026-10-24** (0043 known-limitations branch, node mbp3, `mise run test` via `test:logged`): failed in the bridges group; `bun test --cwd bridges/acp-bridge ./src/acp-test-harness.test.ts --parallel=1` then passed.

## Account-panel review recurrence on 2026-10-24

- **Original command:** `mise run test:logged -- --name account-review-suite -- mise run test`.
- **Worker configuration:** workspace four slots, root one slot, bridges two slots
  (one isolated worker per bridge package), protocol one slot.
- **Failure:** the same test expected `live.exitCode` to be 0 but received null
  at line 56 (13.40 ms). ACP reported 668 passed, 3 skipped, and 1 failed;
  the bridges group finished in 85.4 seconds.
- **Isolated rerun:** `mise run test:logged -- --name acp-harness-rerun -- bun test --cwd bridges/acp-bridge ./src/acp-test-harness.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed unchanged (one test, under 0.1 seconds).
- **Evidence:** `orkestrator-test-run.3LkBxP/bridges.log.gz`.
- **Scope:** this change updates account-panel documentation, comments, and
  renderer tests; it does not change the ACP harness. The existing exit-code
  publication race hypothesis remains unconfirmed.
