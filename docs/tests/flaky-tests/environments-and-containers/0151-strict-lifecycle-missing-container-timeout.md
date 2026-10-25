# Strict lifecycle missing-container timeout

- **ID:** 0151
- **Status:** open
- **Date observed:** 2026-09-20
- **Test:** `environment status and settings commands > strict lifecycle commands still repair an environment whose container is already gone`
- **File:** `apps/backend/tests/commands-registry-environments-status.test.ts`
- **Original command:** `mise run test`
- **Worker configuration:** Root group 3 workers; workspace and bridges 2 slots
  each; protocol 1 slot. Browser validation also ran on this host.
- **Failure:** Timed out after 5000ms (reported duration 6818.69ms), followed by
  an unhandled assertion after the fixture teardown.
- **Suite counts:** Root group: 4344 passed, 2 skipped, 1 failed, 1 error;
  4347 tests across 203 files in 142.59s.
- **Isolated rerun:** `mise run test:logged -- --name lifecycle-isolated -- bun test ./apps/backend/tests/commands-registry-environments-status.test.ts --parallel=1 --only-failures`
  passed in 2.6s.
- **Hypothesis:** The case performs several fake-Docker subprocess operations
  under the default five-second test budget. Aggregate contention can exhaust
  that budget and let outstanding work race fixture teardown. Root cause is
  not confirmed.
- **Failure artifacts:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.g2MjVi/root-and-agent-support-tests.log.gz`

Observed while validating design-pane dividers; no lifecycle code changed.

## Coordinator launch-defaults review validation — 2026-10-16

Recurred in the full suite for `0d254a3a`; the unchanged owning file passed
separately with one isolated Bun worker. Exact failures, suite counts,
commands, durations and evidence are recorded in
[0255](../aggregate-validation-runs/0255-backend-fixtures-launch-defaults-validation.md).
No assertion, deadline or skip was changed.

## Recurrence during live coordinator suite main merge (2026-10-16)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers on a shared 18-slot host.
- **Suite counts:** backend 8,280 passed, 40 skipped, four failed and two
  between-tests errors across 441 files (452.96 seconds). The aggregate exited
  1 after 600.8 seconds. All other workspace packages and the bridge/protocol
  groups passed; root had the Pi staged-runtime timeout tracked as 0178.
- **Evidence:** `/tmp/orkestrator-test-run.3yIsw1/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.i4Amls/merge-tests.log.gz`.

- **Failure:** `strict lifecycle commands still repair an environment whose container is already gone`
  in `apps/backend/tests/commands-registry-environments-status.test.ts` exceeded
  its five-second timeout (9182.61 ms). The same file's
  `agent-test container mounts come from the isolated profile paths, not the host home`
  then failed at 95.58 ms with `ENOENT` reading the fake Docker log. An
  outstanding lifecycle operation also read a removed fixture log between tests.
- **Isolated rerun:** `mise run test:logged -- --name merge-environment-status-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments-status.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file in 8.2 seconds, exit 0.
- **Hypothesis:** shared-host contention and fixture teardown after timeout
  remain plausible explanations; the isolated pass does not establish a cause.
  No test, timeout, assertion or skip was changed.

## Recurrence during Multi Review follow-up validation (2026-10-16)

- **Command:** `mise run test:logged -- --name full-suite -- mise run test`, with 4/1/2/1 workspace/root/bridge/protocol slots and two backend workers.
- **Failure:** the unchanged missing-container repair case exceeded its five-second deadline at 6991.89 ms.
- **Owning-file rerun after the aggregate:** `mise run test:logged -- --name lifecycle-status-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments-status.test.ts --parallel=1 --only-failures` passed unchanged in 4.4 seconds (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.1PZf4j/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. No lifecycle implementation, assertion, timeout or skip changed; the cause remains unconfirmed.

## Multi Review recovery validation — 2026-10-17

- Original command: `mise run test:logged -- --name full-review-recovery -- mise run test` on `4443c027` plus the recovery changes, macOS arm64 under shared-host load. Workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated workers.
- Aggregate: backend 8,632 passed, 41 skipped, four failed and two between-tests errors across 463 files (525.39 seconds); outer run exited 1 after 549.9 seconds. Three failures were known five-second timeouts, and one provider-identity assertion was updated for the new lifetime wrapper and passed in its owning file. All other workspace packages and the root/bridge/protocol groups passed.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.AdrtP5/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.YbWcld/full-review-recovery.log.gz`.
- The missing-container repair case timed out at 6140.30 ms, then a late fixture read reported a missing fake Docker log.
- Unchanged owning-file rerun: `mise run test:logged -- --name status-owner-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments-status.test.ts --parallel=1 --only-failures` passed in 6.4 seconds, exit 0.
- Shared-host contention and teardown after timeout remain hypotheses. No assertion, timeout, skip or implementation in this owner changed.

## Multi Review restart-continuation validation — 2026-10-17

- Original command: `mise run test:logged -- --name full-restart-continuation -- mise run test` on `9da80451` plus the Multi Review restart-continuation change, macOS arm64, alongside another environment's full suite on the same host.
- Aggregate: backend 8,800 passed, 41 skipped, four failed and one between-tests error across 472 files (505.46 seconds). One failure was the change's own provider line-limit breach, fixed before commit; the other three were five-second timeouts in unchanged owners. All other workspace packages and the root, bridge and protocol groups passed.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.vczqfd/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- The missing-container repair case timed out at 5599.26 ms, then a late fixture read reported a missing fake Docker log (the between-tests error).
- Unchanged owning-file rerun: `bun test ./tests/commands-registry-environments-status.test.ts` from `apps/backend` passed 23 of 23.
- No assertion, timeout, skip or implementation in this owner changed.

## Codex catalogue review follow-up recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`
  (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reservations
  4/1/2/1 slots, with two backend workers and concurrent isolated browser and
  other-worktree validation).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.jlxHbv/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
  This obsolete aggregate was interrupted after an integration test moved
  during discovery; its workspace result is incomplete and has no final
  backend test totals. A fresh aggregate validates the final tree.
- **Failure:** `environment status and settings commands > strict lifecycle
  commands still repair an environment whose container is already gone` in
  `apps/backend/tests/commands-registry-environments-status.test.ts` exceeded
  its 5000 ms deadline at 7491.75 ms. The following
  `agent-test container mounts come from the isolated profile paths, not the host home`
  failed at 114.52 ms with `ENOENT` reading the removed fake Docker log.
- **Owning-file rerun:** `mise run test:logged -- --name lifecycle-status-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments-status.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file (exit 0) in 6.6 seconds.
- **Assessment:** the isolated pass confirms intermittence. Host contention
  and fixture teardown after timeout remain hypotheses; no lifecycle source,
  assertion, timeout or skip changed.

## Design live-cycle second main merge — 2026-10-18

The GNU-tool PATH `mise run test:logged -- --name merge-full -- mise run test` (workspace/root/bridges/protocol reservations 4/1/2/1, alongside browser validation) timed out `strict lifecycle commands still repair an environment whose container is already gone` at 5680.10 ms. The unchanged owning file passed `mise run test:logged -- --name merge-unit-owner-commands-registry-environments-status -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments-status.test.ts --parallel=1 --only-failures`, exit 0, in 7.3 seconds logged. Aggregate evidence: `orkestrator-test-run.yluX61/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Confirmed intermittent recurrence; no implementation, assertion, timeout or skip changed.

## CLI matrices second main merge — 2026-10-18

Original command: `mise run test:logged -- --name merge2-tests -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1 alongside component and isolated browser validation. The strict lifecycle case timed out at 9187.64 ms with its companion isolated-profile mounts failure (385.84 ms). The unchanged owning file passed in the four-file one-worker `merge2-late-backend-owners` rerun (exact command and overall result in 0442).
Aggregate result: `merge2-tests` exited 1 after 1132.1 seconds logged. Backend reported 9081 passed, 41 skipped and 11 failed across 9133 tests in 485 files (1118.57 seconds). Every other workspace package passed; root/support passed 3084 tests with one skip, and protocol regeneration passed. Evidence: `orkestrator-test-run.0J1rem/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.

The unchanged owner pass confirms intermittence. No implementation, assertion, timeout or skip changed.
