# Empty process group reported as live in aggregate validation

- **ID:** 9840
- **Status:** resolved
- **Date observed:** 2026-11-06
- **Test:** `groupHasLiveMember > sees a running member and ignores an empty group`
- **Owner:** `packages/protocol/src/node/shell-process-state.test.ts:96`
- **Branch commit:** `1094f412b6960002ced018096dd0ba99faf8d2c5`
- **Aggregate command:** `cd '.' && mise run test:logged -- --name review-default-tests -- mise run test`
- **Worker configuration:** two isolated protocol workers (`2x PARALLEL`) within the concurrent workspace group; root and bridge groups also executing, after approximately 370 seconds queued for host capacity.
- **Failure:** the nonexistent group `2 ** 22 + 1` returned `true` rather than `false`, at 598.16 ms. Protocol: 4,981 passed, two skipped, one failed, 4,984 tests in 265 files, 48.93 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.3ZgUi8/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log` (compressed after aggregate finalization); outer wrapper directory `orkestrator-test-run.IBXph1` under the same temporary root.

## Isolated rerun

`mise run test:logged -- --name address-process-state -- bun --cwd=packages/protocol test ./src/node/shell-process-state.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`

The unchanged complete owner passed with exit 0 in 2.0 seconds. Passing output
was removed by the logged runner; individual passing counts were not retained.
No process-inspection implementation, test, timeout or skip changed. This branch
changes agent-tools listener selection and its regression tests; its protocol
change only adds a log event in `src/log-vocabulary/docker.ts`.

## Hypothesis

On macOS, `groupHasLiveMember` treats an unsuccessful process inspection as
unknown and returns `true`; its `ps` subprocess has a 100 ms timeout. That is a
possible explanation, but no subprocess failure or timeout was captured here.
The isolated pass establishes intermittence, not its cause. Leave this open.

## Scheduling repair validation, 2026-11-09

Observed on `project-scheduling-ac146edab2ff-r1`, base
`3cf3dd7994cb36954f0670430216a71c7b6505d9`. The recurrence tool reported
case 9840 open against `origin/main` and directed recording this recurrence.

Command: `mise run test:logged -- --name address-full-tests-after-guard-fix -- mise run test`.
After an 825.6 s admission wait, the aggregate ran workspace (five slots), root
(one), bridges (two) and protocol (one), beside a five-worker browser suite.
The same empty-group assertion returned true at 425.68 ms. Protocol totals:
5,713 passed, two skipped, one failed; 5,716 tests across 316 files, 45.01 s.
Evidence is the workspace log under
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.IYESto/`.

The unchanged owner passed with
`mise run test:logged -- --name process-group-isolated -- bun test packages/protocol/src/node/shell-process-state.test.ts --parallel=2 --only-failures`
(exit 0, 1.2 s). Passing output was removed, so no isolated total is claimed.
No assertion or timeout changed. Cause remains unconfirmed; the isolated pass
does not replace the failed aggregate or establish an environmental exemption.


## Main merge validation: zombie-only group variant — 2026-11-09

- **Observing branch:** `impeccable-init-f5f64aff930f-r1`, pre-merge head `51fe8c87bf8ac436d6439650255781e05dcc0c85`, base `448e9fffb992c3b6306aa6562c88e23c59fb74d8`, merging `origin/main` at `7074cb4779070bf7c6dbc0dbf619f8b67ebbe883`.
- **Exact test:** `groupHasLiveMember > does not count a zombie as a live member`, `packages/protocol/src/node/shell-process-state.test.ts:103`. This is a related zombie-only group observation in the same owner, rather than the empty nonexistent group assertion above; a shared cause has not been established.
- **Original command:** `mise run test:logged -- --name merge-tests-final -- mise run test`. Protocol ran with two isolated workers inside the concurrent workspace group, alongside root and bridge groups and the component-browser aggregate.
- **Failure:** expected `false`, received `true`, at 318.29 ms. Protocol totals: 5,755 passed, two skipped and one failed across 5,758 tests. This was the only failing test in the final default run; root, bridges and the protocol-lockfile group passed, and the workspace group's other packages passed.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.p7340l/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer wrapper `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.05sHXt/merge-tests-final.log.gz`.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-process-state-isolated -- bun test --cwd packages/protocol ./src/node/shell-process-state.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed, exit 0, in 1.0 second. Passing raw output was deleted by the logged runner.
- **Recurrence check:** `mise run flaky:recurrence -- 9840 --base 448e9fffb992c3b6306aa6562c88e23c59fb74d8` reported the case open.
- **Assessment:** the isolated pass establishes intermittence. The existing hypothesis about the bounded `ps` inspection may also apply here, but no inspection failure or timeout was captured. No process implementation, assertion, timeout or skip changed. The aggregate remains red.


## Completion Notes validation — 2026-11-10

- **Observing branch:** `open-notes-tab-0bdba344d18c-r1`, head `49bc718245`, base `c6de4733c5beb87a578f82a8548725305e1ff254`.
- **Command:** `mise run test:logged -- --name review-default-tests -- mise run test`. After a 1,016.6 s exclusive-lease wait, the workspace group used six slots, root one and bridges two, alongside the component-browser suite. Protocol used two isolated workers.
- **Failure:** `groupHasLiveMember > sees a running member and ignores an empty group`, `packages/protocol/src/node/shell-process-state.test.ts:96`, expected false for `2 ** 22 + 1`, received true at 403.94 ms. Protocol totals: 5,765 passed, two skipped, one failed; 5,768 tests across 318 files in 47.61 s.
- **Evidence:** workspace log `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.KZbVC6/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer wrapper `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.QmChPr/review-default-tests.log.gz` (compressed at finalization).
- **Complete unchanged owner:** `mise run test:logged -- --name process-group-owner-r3 -- bun test --cwd packages/protocol ./src/node/shell-process-state.test.ts --parallel=1 --preload ../../tests/setup-node.ts --only-failures` passed, exit 0, in 1.9 s. Passing raw output was deleted by the logged runner; no isolated count is claimed.
- **Recurrence:** `mise run flaky:recurrence -- 9840 --base c6de4733c5beb87a578f82a8548725305e1ff254` reported the case open and directed recording it. The branch changes pane-layout types, merging and a pipeline log event, but neither the process-inspection implementation nor its test. No inspection failure or timeout was captured; the isolated pass establishes intermittence, not an environmental cause. The aggregate remains red and this case remains open.

## Resolution (2026-11-10)

- **Root cause:** on macOS `groupHasLiveMember`
  (`packages/protocol/src/node/shell-process-state.ts`) runs a synchronous
  `/bin/ps -A -o pgid=,stat=` with `PROCESS_INSPECTION_OPTIONS` (100 ms
  timeout, `SIGKILL`) and, by design, answers `true` ("unknown is yes") when
  the scan does not finish. On a loaded host a real `ps -A` over ~1,300
  processes takes longer: five timed runs at load ~50 took 80 to 210 ms. The
  test asserted the classification of a real, unbounded-in-practice scan, so
  an empty group (`2 ** 22 + 1`) or a zombie-only group read `true`. The
  product side is intended: its only caller, `commandGroupAlive` in
  `command-capture.ts`, polls again with backoff, so a slow scan delays a
  command's settlement instead of deciding it wrongly.
- **Fix:** `shell-process-state.test.ts` runs the two classification cases
  through `withUnhurriedInspection`, which passes `/bin/ps` calls through to
  the real `Bun.spawnSync` with a 30 s timeout, so they check what a
  completed scan means. The 100 ms bound and the unknown-is-yes answer stay
  covered by `process inspection times out and treats failed ps as unknown`.
  `withZombie` now throws if no zombie appeared within its 3 s wait rather
  than running the check against a still-running shell. No assertion was
  loosened.
- **Reproduced:** yes — on the unchanged owner at host load ~50,
  `mise run test:logged -- --name repro-group-live -- bun test --cwd
  packages/protocol --preload ../../tests/setup-node.ts
  ./src/node/shell-process-state.test.ts -t groupHasLiveMember
  --rerun-each=20` failed 15 of 40 (both cases, `true` for `false`). The same
  command after the fix (`fixed-group-live`) passed 40 of 40.
- **Stress:** `mise run test:logged -- --name whole-process-state -- bun test
  --cwd packages/protocol --preload ../../tests/setup-node.ts
  ./src/node/shell-process-state.test.ts --rerun-each=20` passed (macOS, load
  ~50).
