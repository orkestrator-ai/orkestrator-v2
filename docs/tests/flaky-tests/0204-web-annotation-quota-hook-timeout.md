# Web annotation quota hook timeout under aggregate load

- **ID:** 0204
- **Status:** resolved
- **Date observed:** 2026-10-13
- **Test:** `environment quotas through the service > the request count quota refuses a send with usage totals and reserves nothing`.
- **Owning file:** `apps/backend/src/core/web-annotation-quotas.test.ts`.
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`,
  with the documented macOS GNU-tool PATH.
- **Worker configuration:** workspace packages `--parallel=1`, two package
  tasks; root, bridge and protocol groups also ran on the host.
- **Failure:** a beforeEach/afterEach hook exceeded its 10,000 ms deadline,
  reported at 10,000.19 ms.
- **Backend suite:** 5,875 passed, 15 skipped, 27 failed across 329 files in
  442.53 seconds; 22 failures reproduced as tmux cleanup errors on this host.
- **Isolated rerun:** with the same PATH,
  `mise run test:logged -- --name quotas-rerun -- bun --cwd=apps/backend test ./src/core/web-annotation-quotas.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed unchanged (exit 0) in 5.1 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.TrudTm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The isolated pass supports a load-sensitive fixture setup or cleanup timeout;
the evidence does not establish which hook stalled. No test assertions, deadlines
or skips were changed.

## Additional observation on 2026-10-13

- **ID:** 0204
- **Status:** open
- **Date observed:** 2026-10-13
- **Original command:** `mise run test:logged -- --name fix-full-suite -- mise run test`
- **Worker configuration:** normal aggregate allocation; backend used one Bun worker while root and bridge groups and component/isolated browser validation ran on the host.
- **Failure:** `environment quotas through the service > the request count quota refuses a send with usage totals and reserves nothing` in `apps/backend/src/core/web-annotation-quotas.test.ts` exhausted a beforeEach/afterEach hook timeout at 10005.53 ms.
- **Suite counts:** backend reported 5877 passed, 15 skipped and 25 failed; 22 failures were environment-move cleanup errors and two were keyed-scheduling timeouts.
- **Isolated rerun:** `mise run test:logged -- --name fix-quotas-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/web-annotation-quotas.test.ts --parallel=1 --only-failures` passed (exit 0, 2.4 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.Pv387k/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** fixture lifecycle work exceeded its deadline under aggregate load or shared backend activity. The owning test and backend were unchanged; the cause is unconfirmed. No test was skipped or timeout raised.

## Resolution (2026-10-17)

- **Status:** resolved
- **CI history:** `gh run list --workflow lint.yml --created ">=2026-10-01"`
  returned 327 runs (212 failed). Scanning every failed log found this test in
  13 runs, 4 on `main` (37042129544, 37118083684, 38403589006, 38473492724).
  Eleven report `this test timed out after 5000ms` with the test body at
  5,797–9,847 ms; two (37042078129, 37135282071) report
  `a beforeEach/afterEach hook timed out for this test` at 10,000.08 and
  10,000.21 ms. The last hit was run 38538035041, created
  2026-10-14T08:50Z. None of the 178 runs created after c95479da1 merged
  (2026-10-14T19:03Z, 88 failed for other reasons) contains it.
- **Root cause:** a real per-record fsync loop in the pre-SQLite storage. The
  test faked 5,000 requests by writing a version 1 `manifest.json` that carried
  request text inline. After the restart, the first commit (`createAnnotation`
  for "second") found no persisted text for any request and wrote 5,000
  `request-text` records, each with its own `mkdir`, temp-file write, `fsync`,
  `rename` and `unlink` (`writeDurable`; `syncDirectories: false` skipped only
  directory syncs). The `afterEach` then removed 5,006 record directories
  recursively. Measured on the pre-SQLite tree (`git archive c95479da1^`), the
  restart took 15 ms, that single create 1,874 ms, the refused send 21 ms,
  and `harness.cleanup()` 480 ms; the case took 2.64 s of the file's 2.83 s.
  On a slower, loaded CI disk the create alone exceeded the 5 s test
  deadline, and when it overran far enough the pending cleanup exhausted the
  10 s hook deadline.
- **Fix:** c95479da1 (#969, `feat(storage): migrate backend persistence to
  SQLite`) moved web annotation storage to SQLite. Records and index rows now
  commit in one transaction with no per-record file, and the test seeds the
  5,000 requests through `store.mutate` instead of a version 1 manifest. No
  test or production change was needed on this branch, and no deadline,
  assertion or limit was changed. The remaining cost is the designed
  O(manifest) clone and row plan per commit (about 25 ms per commit at 5,000
  requests).
- **Verification (Apple silicon, 18 cores, Bun 1.4.3, current tree):**
  - Alone: the case took 0.154 s; the file passed 15/15 in 385 ms.
    Per phase: fixture mutate 77–97 ms, restart 20–22 ms, create 26–31 ms,
    refused send 20–25 ms, cleanup 2–3 ms.
  - `bun test --preload ../../tests/setup-node.ts ./src/core/web-annotation-quotas.test.ts --rerun-each 20`:
    300/300 passed in 6.71 s; the case took 0.159–0.197 s (median 0.177 s).
  - Same command under CPU stress (36 `yes` busy loops on 18 cores):
    300/300 passed in 31.2 s; the case took 0.74–1.49 s (median 1.18 s).
    The pre-SQLite tree under the same stress (`--rerun-each 5`) took
    2.27–2.77 s for the case, without CI's slower disk.
  - Backend aggregate, `bun test --preload ../../tests/setup-node.ts src tests --parallel=2`,
    alongside other agents' suites: 8,481 passed, 40 skipped, 12 failed in
    369 s. None of the failures was in a web annotation file. This case took
    0.203 s and its file 0.431 s.
