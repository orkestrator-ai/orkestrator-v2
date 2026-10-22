# `ACP bridge > bounds one oversized response without failing the session` (`bridges/acp-bridge/src/index.test.ts`)

- **ID:** 0050
- **Status:** open
  2026-09-06 changes do not touch this owner
- **Date observed:** 2026-08-16
- **Original command:** `bun run test:logged -- --name fixes-full-tests -- bun run test`
  at `88b56425006c8664d2c1d669af0203ef196df273`.
- **Worker configuration:** the bridge group used two Bun workers while the
  workspace, root/agent-support, and protocol-lockfile groups ran concurrently.
- **Failure:** `spawnBridge` exhausted its 5,000 ms health wait before the test
  could begin its oversized-response assertions: `Timed out waiting for ACP
  state: false` at `index.test.ts:113`, reached from `spawnBridge` at line 158.
  The failing case took 5,011.22 ms and reported no product assertion mismatch.
- **Suite counts:** bridges group: 2,537 passed, 11 skipped, 1 failed, 8,460
  assertions across 70 files in 51.36 seconds. The workspace, root/agent-support,
  and protocol-lockfile groups passed.
- **Isolated rerun:** `bun run test:logged -- --name isolate-acp-oversized-response -- bun test ./bridges/acp-bridge/src/index.test.ts --test-name-pattern "bounds one oversized response without failing the session" --only-failures`
  passed in 0.3 seconds. The complete owning file had also passed in 34.2 seconds
  immediately before the aggregate run.
- **Hypothesis:** aggregate process-start contention delayed the bridge health
  endpoint beyond `waitFor`'s fixed five-second budget. This is the same startup
  boundary as the resolved Cursor child-settlement flake below, but now occurred
  before a different case. The product behavior and the test's oversized-frame
  assertions both pass when the bridge can start without aggregate contention;
  a readiness signal or a startup-specific budget should be evaluated before
  changing those assertions.
