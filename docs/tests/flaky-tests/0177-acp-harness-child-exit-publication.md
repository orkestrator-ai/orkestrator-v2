# ACP harness child exit publication

- **ID:** 0177
- **Status:** open
- **Date observed:** 2026-10-02
- **Original command:** `mise run test:logged -- --name steer-suite -- mise run test`
- **Worker configuration:** normal aggregate host allocation; bridge packages use their configured isolated workers. Browser validation also ran on the host.
- **Failure:** `ACP test harness child tracking > awaits and deregisters live and already-exited children before deleting fixtures` at `bridges/acp-bridge/src/acp-test-harness.test.ts:56` expected `live.exitCode` to be 0 after cleanup, but received null (38.43 ms).
- **Isolated rerun:** `mise run test:logged -- --name steer-acp-harness-isolation -- bun test ./bridges/acp-bridge/src/acp-test-harness.test.ts --parallel=1 --only-failures` passed in 0.1 seconds.
- **Evidence:** aggregate artifact `orkestrator-test-run.kPWByh/bridges.log.gz`; aggregate failed with this single bridge test failure. Workspace and protocol groups passed.
- **Hypothesis:** subprocess completion and publication of `exitCode` may race under aggregate load. The steering fixes do not change this harness or its child lifecycle. No test was skipped or loosened; the cause remains unconfirmed.
