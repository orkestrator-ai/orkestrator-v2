# `ACP bridge > bounds one oversized response without failing the session` (`bridges/acp-bridge/src/index.test.ts`)

- **ID:** 0050
- **Status:** resolved
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

## Resolution (2026-11-10)

- **Status:** resolved; the owning file no longer exists and the startup
  boundary that failed was rewritten.
- **Root cause:** the 0050-era `spawnBridge` reserved a port with
  `unusedPort()` (bind port 0, read it, close it), spawned the bridge on it and
  then polled the unauthenticated `/global/health` for at most 5 s, reading
  every failure as `false`. It could not tell a slow start from a child that
  had already exited, for example after another worker took the released
  port, the mechanism proven in
  [0876](0876-acp-harness-port-squatter-401.md). Either way the wait ran out
  at `Timed out waiting for ACP state: false`. Which of the two happened here
  was not recorded.
- **Fix:** already on `main`. `f636cc198` (#419) split
  `bridges/acp-bridge/src/index.test.ts`; this test is now in
  `acp-http.test.ts` and uses the shared `acp-test-harness.ts`. `f65cc0044`
  (#424) gave startup its own `BRIDGE_STARTUP_TIMEOUT_MS` (15 s) apart from
  the 5 s state wait. `182a40315` (#1265) made readiness need the spawned
  child alive, its own post-bind `server.listening` line and an accepted
  `/global/auth-check`, and replaces a child that exits while starting with
  one on a fresh port (up to three attempts). That change has its own
  deterministic regressions in `src/acp-test-harness.test.ts`. No change in
  this sweep.
- **Reproduced:** no — the original owner is gone and the failure was never
  recorded with the child's state. The port-loss mechanism was reproduced and
  fixed under 0876. The test has not been recorded failing in its new owner
  since the split.
- **Stress:** `mise run test:logged -- --name acp-oversized-0050 -- bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts ./src/acp-http.test.ts -t "bounds one oversized response" --rerun-each=10`
  passed (exit 0) on a host at load average about 35. This is a pass on
  the current harness, not proof of the old failure's cause.
