# Build pipeline scheduling timeouts under aggregate load

- **ID:** 0205
- **Status:** resolved
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

## CI recurrences — 2026-10-02 to 2026-10-10

GitHub Actions `lint.yml` "Unit and integration tests" job,
`@orkestrator/backend:test:workspace` (`--parallel=${ORKESTRATOR_TEST_WORKERS:-2}`):

- Run 37042078129 (`investigate-opencode-connection-98afc99a4f4b-r1`,
  2026-10-02): `old and new drivers make the same transitions from one
  persisted fixture` timed out at 5,003.28 ms.
- Run 37135282071 (`desktop-app-packaging-af18ec33a8cf-r1`, 2026-10-03):
  the same test timed out at 5,031.97 ms.
- Run 38096855564 (`remove-task-gaps-cec3daec727b-r1`, 2026-10-10): the same
  test timed out at 5,003.95 ms. An unhandled error between tests followed:
  `TypeError: null is not an object` in `phaseOf` (test line 213), called from
  the `whileBusy` read at line 262 after `afterEach` had already removed the
  fixture.

## Resolution — 2026-10-17

- **Status:** resolved
- **Root cause:** fixture cost, not a scheduler race. Each pipeline that
  `fixture()` seeded went through `addEnvironment`, `start` and two
  `advanceNow` passes, and the completed ones took one more save. That is
  about 24 write transactions per pipeline. The backend database runs
  `PRAGMA synchronous = FULL`, so every write transaction fsyncs, and
  `bun:sqlite` blocks the event loop while it does. A wrapper on
  `StorageDatabase.runTransaction` counted writes per test:
  - `old and new drivers…` made 1,574 write commits. It seeds two 32-pipeline
    fixtures, one per driver, and 30 pipelines in each are completed records
    that only have to exist.
  - `retained history…` made 991 write commits for its 41 pipelines.

  On a fast local disk the first test takes about 0.4 s. A durable commit
  latency of roughly 3 ms or more, which a loaded CI runner or aggregate host
  can reach, puts it past the 5 s deadline. Bun does not cancel a timed-out
  body. It kept running after `afterEach` had shut the services down and
  deleted the data directory. That explains the null `phaseOf` read and the
  late `SQLITE_IOERR_VNODE`. It also explains why the next test's global
  `recurringWorkMetrics` counted 155 scanned records instead of 123: 32 extra
  came from the leaked 32-record fixture.
- **Reproduction:** a test-only preload made every write transaction block
  for `FSYNC_MS` after commit (`Bun.sleepSync`). With the unchanged file at
  `FSYNC_MS=4`, both `old and new drivers…` (5,093.74 ms) and
  `retained history…` (5,070.16 ms) timed out. An unhandled
  `SQLITE_IOERR_VNODE` between tests followed, matching the 2026-10-15 local
  recurrence.
- **Fix:** this branch, test fixture only
  (`apps/backend/src/core/build-pipeline-scheduling.test.ts`):
  - Only the active pipelines and the first completed pipeline go through
    the service path. Every later completed record is a copy of the first one's
    persisted snapshot, re-keyed to a new id, environment and task. One
    `saveBuildPipeline` at revision 1 writes it (`controller: "backend"`,
    `backendRevision: 1`), so `init` adopts it without a re-save. Each
    completed pipeline still has its own environment.
  - `old and new drivers…` seeds one fixture. Its name always described one
    fixture, but it used to seed two. The keyed driver runs on a
    byte-identical copy: `copyFixture` closes the source storage, which
    checkpoints the WAL, copies the data directory, and copies each stub
    provider's state, including recorded sends and its session counter.

  Write commits fell from 1,574 to 261 and from 991 to 250. No assertion,
  deadline or production code changed, and nothing was skipped.
- **Verification:**
  - Alone: 7 pass in 1.1 s. `--rerun-each 50` → 350 pass, 0 fail (37.1 s).
  - Slow-commit emulation, changed file: `FSYNC_MS=4` → 1.65 s and 1.54 s for
    the two tests. `FSYNC_MS=8` → 2.76 s and 2.75 s. `FSYNC_MS=12` → 4.10 s
    and 3.87 s. All 7 tests passed at every setting. Before the change,
    `FSYNC_MS=4` timed out.
  - CPU stress: 18 `yes` burners on 18 cores. `--rerun-each 20` ran concurrently
    with `FSYNC_MS=6 --rerun-each 5` and the 0268 `lifecycle.test.ts` stress
    run → 140 pass and 35 pass, 0 fail.
  - `oxfmt --check`, `oxlint` and `tsc --noEmit -p tsconfig.json` /
    `tsconfig.test.json` in `apps/backend` passed.
