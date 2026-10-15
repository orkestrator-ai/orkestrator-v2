# Build pipeline scheduling timeouts under aggregate load

- **ID:** 0205
- **Status:** open
- **Date observed:** 2026-10-13
- **Tests:** `BuildPipelineService keyed scheduling > old and new drivers make the same transitions from one persisted fixture`
  and `BuildPipelineService keyed scheduling > retained history is enumerated only by the safety scan`.
- **Owning file:** `apps/backend/src/core/build-pipeline-scheduling.test.ts`.
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`,
  with the documented macOS GNU-tool PATH.
- **Worker configuration:** workspace packages `--parallel=1`, two package
  tasks; root, bridge and protocol groups also ran on the host.
- **Failures:** the tests exceeded their 5,000 ms deadlines at 5,003.38 ms and
  5,004.95 ms respectively.
- **Backend suite:** 5,875 passed, 15 skipped, 27 failed across 329 files in
  442.53 seconds; 22 failures reproduced as tmux cleanup errors on this host.
- **Isolated rerun:** with the same PATH,
  `mise run test:logged -- --name build-scheduling-rerun -- bun --cwd=apps/backend test ./src/core/build-pipeline-scheduling.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed unchanged (exit 0) in 5.4 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.TrudTm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The isolated pass supports load-sensitive scheduling or fixture work, but does
not identify the blocking operation. No assertions, deadlines or skips were
changed.

## Additional observation on 2026-10-13

- **ID:** 0205
- **Status:** open
- **Date observed:** 2026-10-13
- **Original command:** `mise run test:logged -- --name fix-full-suite -- mise run test`
- **Worker configuration:** normal aggregate allocation; backend used one Bun worker while root and bridge groups and component/isolated browser validation ran on the host.
- **Failures:** `BuildPipelineService keyed scheduling > old and new drivers make the same transitions from one persisted fixture` timed out at 5147.39 ms; `BuildPipelineService keyed scheduling > retained history is enumerated only by the safety scan` timed out at 5000.59 ms in `apps/backend/src/core/build-pipeline-scheduling.test.ts`.
- **Associated errors:** late work read a null pipeline snapshot in `phaseOf`, and the safety scan observed 44 scanned records instead of 123 after the timed-out tests.
- **Suite counts:** backend reported 5877 passed, 15 skipped and 25 failed; 22 failures were environment-move cleanup errors and one was an annotation quota hook timeout.
- **Isolated rerun:** `mise run test:logged -- --name fix-scheduling-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/build-pipeline-scheduling.test.ts --parallel=1 --only-failures` passed (exit 0, 2.9 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.Pv387k/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** scheduler progress and fixture cleanup exceeded the generic test deadline under aggregate load or shared backend activity. The owning test and backend were unchanged; the cause is unconfirmed. No test was skipped or timeout raised.

## Recurrence during main merge validation — 2026-10-15

- **Tests:** `old and new drivers make the same transitions from one
  persisted fixture` timed out at 5,574.47 ms. The subsequent
  `retained history is enumerated only by the safety scan` observed 155
  records instead of 123 and failed at 1,355.24 ms.
- **Associated error:** late `phaseOf` work from the timed-out first test
  read storage after teardown, raising `SQLITE_IOERR_VNODE` between tests.
- **Original command:** `PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" mise run test:logged -- --name merge-main-full-suite -- mise run test`.
- **Worker configuration:** backend package `--parallel=2`, two workspace
  package tasks, alongside the other aggregate groups and other host validations.
- **Suite counts:** backend 7,745 passed, 39 skipped, 6 failed and one
  between-tests error across 7,790 tests in 427 files (361.91 seconds).
  The whole aggregate finished in 594.9 seconds; root and protocol groups passed,
  while the bridges group also reported the ACP hook timeout tracked as 0219.
- **Evidence:** `/tmp/orkestrator-test-run.jDL6Dp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name
  build-pipeline-scheduling-isolated -- bun test --cwd apps/backend
  --preload ../../tests/setup-node.ts ./src/core/build-pipeline-scheduling.test.ts
  --parallel=1 --only-failures` passed unchanged in 3.1 seconds.
- **Hypothesis:** late work from a timed-out case can affect the following
  test and outlive its fixture storage. The unchanged isolated pass matches
  earlier observations; no timeout, assertion or skip was changed.
