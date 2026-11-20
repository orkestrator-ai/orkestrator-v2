# The relayed push acceptance test can exceed its virtual latency budget

Relocated tests from the recorded commands now live at
`apps/backend/src/core/review/transcript-push.test.ts` and
`apps/backend/src/core/review/service-part-4.test.ts`.

- **ID:** 10008
- **Status:** resolved
- **Observed:** 2026-11-20 on the push-layer review fixes, based on
  `5e9835d0a6981a8d2c217d8941e2e065abbe3008`, after reviewed commit `f255a06da`.
- **Test:** `push acceptance budgets > two relayed nodes share bridge reads across windows and meet the latency budget`
- **File:** `apps/backend/tests/push-acceptance.test.ts`
- **Original command:** `mise run test:logged -- --name findings-backend -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts src/core/http-bridge/state-revision.test.ts src/core/push/native-session-push-topic.test.ts src/core/push/review-transcript-push-topic.test.ts src/core/native-agent-tool-output-reads.test.ts src/core/nodes/node-push-subscriptions.test.ts src/core/multi-review-transcript-push.test.ts src/core/multi-review-service-part-4.test.ts tests/push-acceptance.test.ts --parallel=4 --only-failures`.
- **Failure:** observed p95 of 300 ms against the 250 ms virtual-time limit.
  The case ran for 1.66 seconds. The run reported 136 passed and 3 failed
  across eight files. The two other failures were fixture setup mistakes in new
  reviewer count tests. Evidence: `/tmp/orkestrator-test-run.qvEDlP/findings-backend.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name findings-acceptance-only -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts tests/push-acceptance.test.ts --parallel=1`
  passed the owning file in 23.8 seconds.
- **Open question:** the manual clock advances in 25 ms increments while the
  relay reads real SSE sockets outside the fixture's quiescence check. It is
  unclear whether delayed socket delivery or a product scheduling race explains
  the extra virtual ticks. The latency limit and scenario remain unchanged.

## Recurrence on 2026-11-20

- **Observed:** while merging `origin/main` at `0b778d995` into `03261be68`,
  whose merge base was `5e9835d0a6981a8d2c217d8941e2e065abbe3008`.
  The case was branch-local before renumbering, so the recurrence check used
  its old number 10003 against the pre-merge branch and reported it open.
- **Aggregate command:** `mise run test:logged -- --name merge-default-suite -- mise run test`.
  The backend ran with four Bun workers. The case measured virtual p95 of
  275 ms against its 250 ms budget and failed after 1105.76 ms. The backend
  suite reported 19,956 passed, 152 skipped, and two failed across 1,415 files.
  Evidence: `/tmp/orkestrator-test-run.oFfodQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-push-acceptance-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/push-acceptance.test.ts --parallel=1 --only-failures`
  passed the owning file in 11.6 seconds. The relay still reads real SSE
  sockets outside the fixture's quiescence check, and the source of the
  extra virtual tick remains unverified.

## Later recurrence on 2026-11-20

- **Observed:** while merging `origin/main` at `2f2c4b383` into `df73b63e8`,
  whose merge base was `0b778d9957ba241e34231f6f86b2ce0e97205c05`. The
  recurrence check found the open case on the pre-merge branch.
- **Aggregate command:** `mise run test:logged -- --name refresh-main-default-suite -- mise run test`.
  The backend ran with four Bun workers. The case measured virtual p95 of
  300 ms against its 250 ms budget and failed after 908.40 ms. The backend
  suite reported 19,972 passed, 152 skipped, and one failed across 1,417 files.
  Evidence: `/tmp/orkestrator-test-run.QhGIbq/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name refresh-main-push-acceptance-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/push-acceptance.test.ts --parallel=1 --only-failures`
  passed the owning file in 10.7 seconds.

## Recurrence on `main` CI, 2026-11-20

- **Observed:** GitHub Actions run 44713370307, `CI` on `main` at
  `a296c3777f65f1a5f8aaf1899851957e058d08ea`, `Tests (backend)` shard,
  Linux x64. `mise run flaky:recurrence -- 10008 --base a296c3777f65f1a5f8aaf1899851957e058d08ea`
  reported the case open.
- **Failure:** virtual p95 of 300 ms against the 250 ms budget
  (`push-acceptance.test.ts:163`), after 371.70 ms.
- **Rerun alone:** the runner's single rerun of
  `apps/backend/tests/push-acceptance.test.ts` failed too ("FAILED ALONE", 4.4 s).
  This is the first observation of the case failing outside an aggregate run,
  so aggregate load alone does not explain it.
- **Next run:** `main` CI run 44720980632 at `6db2b4164` passed the backend
  shard, case included.


## Resolution (2026-11-20)

- **Root cause:** the relay's leaf SSE client was outside the virtual
  clock's quiescence check. The clock could advance past the command node's
  next coalescing window while a leaf frame was still in transit on a real
  socket. Smaller virtual steps did not ensure the frame had arrived.
- **Fix:** the acceptance fixture waits for the relay handshake, leaf SSE
  bytes, relay subscription calls and viewer reads before advancing virtual
  time. The test uses the real sockets and keeps the 250 ms p95 budget and
  revision and read-sharing assertions.
- **Reproduced:** yes — eight isolated repetitions on reviewed commit
  `8273d6369121e32214f3f2165b96ede0a096c902` (merge base
  `6db2b41649cbc539281650dd5db35e3cc6bb1b18`) failed, including the
  300 ms p95 and a viewer stopping one revision short. Evidence:
  `/tmp/orkestrator-test-run.LwntbV/findings-latency-before.log.gz`.
- **Stress:** `mise run test:logged -- --name findings-latency-after -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/push-acceptance.test.ts --parallel=1 --rerun-each=8 -t 'two relayed nodes'`
  passed all eight repetitions with the relay included in quiescence.

## Isolated failures on 2026-11-20

- **Observed:** on the `review` domain move of to-do 0012, based on
  `05f3db2d8`. `mise run flaky:recurrence -- 10008 --base 05f3db2d8`
  reported the case open.
- **Command:** `NODE_ENV=test bun scripts/run-logged.ts --name review-importer-tests -- bun --cwd=apps/backend test --preload ../../tests/setup-node.ts <33 test files> --parallel=4 --only-failures`,
  where it measured virtual p95 of 300 ms against its 250 ms budget; the
  other 32 files passed (789 of 790 tests).
- **Isolated reruns:** the owning file alone
  (`bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/push-acceptance.test.ts`)
  failed three times out of three with p95 300 ms (8 passed, 1 failed), on
  the branch and on an untouched checkout of `05f3db2d8`. Unlike the earlier
  observations it did not pass alone, so on this host (macOS, Apple Silicon)
  it now fails deterministically on `main`. The move does not touch the push
  layer; only the test's import path changed.
