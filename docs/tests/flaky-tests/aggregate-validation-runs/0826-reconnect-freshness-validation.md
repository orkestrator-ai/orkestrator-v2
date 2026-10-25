# Reconnect freshness validation: unrelated backend failures under host load

- **ID:** 0826
- **Status:** open
- **Date observed:** 2026-10-25
- **Change under test:** `33b96fb48`, renderer tests for App transport activation,
  retry lifecycle, terminal recovery, gateway state listeners and PR tooltips.
  No backend source or tests changed.
- **Original command:** `mise run test:logged -- --name reconnect-repository-final -- mise run test`.
- **Worker configuration:** default workspace/root/bridges/protocol reservations
  4/1/2/1; backend used two Bun workers. Other worktrees were validating on the
  same 18-core macOS host. During owner diagnosis, load averages were
  65.94 / 56.23 / 43.53; the checkout is on the shared external Lexar drive.
- **Final aggregate result:** exit 1 after 1269.9 s logged. Backend reported
  10,730 passed, 84 skipped and five failed across 10,819 tests and 624 files
  (1194.57 s). Every other workspace package passed, including all 9701 web
  tests. Root/support, bridges and protocol regeneration passed (304.5 s,
  110.0 s and 692 ms respectively). The focused renderer suites and
  `mise run test:logged -- --name reconnect-check -- mise run check` passed.
  Browser and Electron scenario suites were not selected for these test-only
  renderer changes.
- **Failures:**
  - `apps/backend/src/core/commands-state-sync.test.ts:3186`,
    `durable tab teardown commands > times out a hanging provider delete without blocking other intents`:
    the reconcile result was correct, but the elapsed bound expected less than
    250 ms and received 336.97 ms (376.15 ms test duration). Recurrence of
    [0460](../backend-services-and-tooling/0460-tab-teardown-hanging-delete-elapsed-bound.md).
  - `apps/backend/tests/recurring-baseline.test.ts`,
    `driven native observation baseline (step 07) > is deterministic, content-free, and sharing drops reads without losing edges`:
    exceeded the unchanged 5000 ms timeout (5025.31 ms). See
    [0177](../native-agents-and-transcripts/0177-driven-observation-baseline-timeout.md).
  - `apps/backend/src/core/agent-accounts-active.test.ts:571`,
    `renews an expired owner login without ordinary sessions before the coordinator handoff`:
    expected `login.loginless` to be undefined, received `true` (32.36 ms).
  - `apps/backend/src/core/native-agent-command-catalogue-scale.test.ts`,
    `command catalogue under load > 256 maximal inventories stay within the byte budget with exact accounting and LRU eviction`:
    exceeded the unchanged 5000 ms timeout (5838.18 ms).
  - `apps/backend/src/core/commands-registry-teardown.test.ts:263`,
    `tab close retains conversation history > a bridge close can finish after the legacy request budget`:
    expected `teardown_tab` to resolve `{ completed: true }`, but the promise
    rejected (408.08 ms).
- **Complete owning-file rerun:**
  `mise run test:logged -- --name backend-failure-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-state-sync.test.ts ./tests/recurring-baseline.test.ts ./src/core/agent-accounts-active.test.ts --parallel=1 --only-failures`.
  Bun isolated the files and ran one worker. Result: 199 passed, one failed,
  868 expectations across three files (71.5 s logged). The complete teardown
  and account-login owners passed unchanged. The baseline owner again
  exceeded five seconds (5215.64 ms), so this observation leaves it unresolved.
- **Complete scale-owner rerun:**
  `mise run test:logged -- --name catalogue-scale-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-command-catalogue-scale.test.ts --parallel=1 --only-failures`
  also timed out (6472.36 ms): eight passed, one failed, 667 expectations
  across nine tests (10.0 s logged). This owner remains unresolved under the
  same host load; it is not established as a new flake by this rerun.
- **Complete bridge-close owner rerun:**
  `mise run test:logged -- --name teardown-registry-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-registry-teardown.test.ts --parallel=1 --only-failures`
  passed unchanged (8.6 s logged). This establishes intermittence for the
  bridge-close failure; no owner assertion or timeout was changed.
- **Earlier full run:** `mise run test:logged -- --name reconnect-repository -- mise run test`
  passed every workspace package, bridges and protocol regeneration in
  468.6 s logged. Root reported 3417 passed and one assertion-diagnostics
  violation introduced by this change. That violation was fixed by comparing
  DOM absence as a boolean; the focused guard and final complete root rerun
  passed. It was a corrected test defect, not a flake.
- **Evidence:** below the host temporary directory,
  `orkestrator-test-run.HtemCW/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  (final aggregate after finalization),
  `orkestrator-test-run.JRyJ2U/reconnect-repository-final.log.gz`,
  `orkestrator-test-run.P4mbX5/backend-failure-owners.log.gz`,
  `orkestrator-test-run.kj4F8w/catalogue-scale-owner.log.gz`, and
  `orkestrator-test-run.ggmWV4/root-and-agent-support-tests.log.gz` (first run).

## Assessment

The teardown elapsed bound, bridge close and login handoff are intermittent: their complete
unchanged owners passed with one isolated worker. Host contention is a plausible
cause for the time bound and baseline timeout, supported by the measured load,
but does not establish the cause of the account-login result. That case performs
two concurrent login reads while refreshing a file; a refresh/read race is a
hypothesis, not a demonstrated diagnosis. The baseline and command-catalogue scale timeouts remain unresolved
because they also failed in the owning-file reruns. No assertion, timeout or skip in
these unrelated owners was changed.
