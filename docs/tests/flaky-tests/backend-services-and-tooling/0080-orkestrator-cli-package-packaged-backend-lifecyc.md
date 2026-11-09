# `orkestrator CLI package` packaged-backend lifecycle (`packages/cli/tests/cli.test.ts`)

- **ID:** 0080
- **Status:** open
- **Date observed:** 2026-08-14
- **Original command:** `bun run test` (workspace group, Turbo task `@orkestrator/cli#test:workspace`).
- **Worker configuration:** Turbo's workspace group running concurrently with the root, bridge, and protocol-lockfile groups. Unlike the resolved built-artifact flake above, the CLI file was selected exactly once — the duplicate-selection root cause fixed there does not apply here.
- **Failure:** Two cases in the same run.
  1. `starts and gracefully stops the packaged backend` (4,327.86 ms): `expect(received).toBe(expected)`, `Expected: 0`, `Received: 143`, at `cli.test.ts:267:55`, followed by `killed 1 dangling process`. 143 is SIGTERM, so the packaged backend did not complete its graceful shutdown inside the window the test allows before the harness force-kills it.
  2. `starts when the caller's environment already sets NODE_ENV` (5,001.07 ms): `this test timed out after 5000ms`, plus an unhandled `error: Packaged backend did not become ready:` (empty stderr payload) from `startPackagedBackend` at `cli.test.ts:145:15`, called from `cli.test.ts:274:45`.
- **Suite counts:** CLI package 6 passed, 2 failed, 1 error; Turbo reported `Tasks: 5 successful, 7 total` with `Failed: orkestrator#test:workspace`. Concurrent groups were green: root 3,903 passed / 1 skipped / 0 failed; bridges 2,372 passed / 11 skipped / 0 failed; codex protocol lockfile passed. Turbo aborted the workspace group on this failure, so the web, desktop, and web-public workspace tasks did not execute in that run and iOS never started.
- **Isolated rerun:** `bun run --cwd packages/cli test` (builds, then `bun test tests --parallel`) -> 8 passed, 0 failed, 27 assertions in 2.17 seconds. Both affected cases passed.
- **Recurrence (attachment-only startup fix, 2026-08-15):** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-image-only-full-tests.log` failed `starts and gracefully stops the packaged backend` after 5,001.45 ms while the workspace group competed with the root, bridge, and protocol groups. Readiness never arrived before the outer budget, cleanup killed one dangling process, and `startPackagedBackend` subsequently reported an empty-stderr readiness failure between tests. The CLI package reported 7 passed and 1 failed before Turbo aborted the backend task with exit 130; root passed 3,656 with 1 skipped, bridges passed 2,425 with 11 skipped, and the protocol lockfile passed. The immediate isolated rerun, `bun test --cwd packages/cli tests/cli.test.ts`, passed all 8 tests with 27 assertions in 6.79 seconds; the affected case completed in 3,560.81 ms. Evidence: `/tmp/orkestrator-image-only-full-tests.log` and `/tmp/orkestrator-cli-packaged-backend-isolated.log`.
- **Hypothesis:** No root cause is established from one occurrence. Both cases spawn the real packaged backend and wait on a fixed wall-clock budget — readiness in one, graceful exit in the other — while three other test groups saturate the machine. Neither failure mode involves a missing artifact, which is what separates this from the resolved entry above. A recurrence should capture backend startup and shutdown timings before the budgets are changed, since raising them would also hide a genuine shutdown regression.
- **Recurrence (remote-client data efficiency, 2026-09-05):** `bun run
  test:logged -- --name full-suite-efficiency-final-2 -- bun run test` failed
  `starts when the caller's environment already sets NODE_ENV` after 1,953.79
  ms: the backend became ready, but its shutdown returned signal-derived status
  `143` instead of `0`. The CLI package reported 7 passed, 1 failed, and 27
  assertions; Turbo stopped the workspace group after 4.6 s while the root,
  bridge, and protocol-lockfile groups passed. The immediately preceding full
  suite had passed, and this change does not touch CLI lifecycle code. The
  isolated rerun, `bun run test:logged -- --name cli-shutdown-isolated -- bun
  --cwd=packages/cli test --preload ../../tests/setup-node.ts
  ./tests/cli.test.ts --only-failures --parallel=2`, passed all 8 cases in 3.0
  s. This is the same graceful-shutdown signature as the original occurrence,
  so the entry is reopened. Evidence:
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.CZzDC6`.
- **Second recurrence (projection-suite split, 2026-09-05):** the same case
  failed the same way in `bun run test:logged -- --name split-suite -- bun run
  test` after 1,402.27 ms, with `stopPackagedBackend` resolving `143` instead
  of `0`. The CLI package reported 7 passed, 1 failed, 27 assertions across 8
  tests in 4.13 s; the workspace-group failure then interrupted the backend
  group with exit 130, leaving 94 backend files unstarted. The change in flight
  only moved backend test blocks between files and touches no CLI or backend
  lifecycle code, and the immediately preceding full suite passed. The isolated
  rerun, `bun --cwd=packages/cli test --preload ../../tests/setup-node.ts
  ./tests/cli.test.ts --parallel=2`, passed all 8 cases in 2.1 s. Two
  occurrences one day apart with an identical signal-derived exit status make
  the graceful-shutdown race, not the readiness budget, the thing to
  instrument next.
- **Collateral note:** Because a workspace-group failure aborts the remaining Turbo tasks, this flake silently drops web/desktop/web-public coverage from an aggregate run. Treat a workspace-group failure as "the rest of that group did not run", not as "the rest of that group passed".

## Recurrence: X1 review preparation, 2026-11-05

- Original command: `mise run test:logged -- --name review-default-tests -- mise run test`
  at `5bec27835ffc2feb843f17b6862779be45da14f6`. The captured CLI task used
  `--parallel=2` inside the concurrent workspace/root/bridge/protocol run.
- `orkestrator CLI package > starts and gracefully stops the packaged backend`
  failed after 20,049.21 ms and `orkestrator CLI package > starts when the caller's
  environment already sets NODE_ENV` failed after 20,008.72 ms. Both reported
  `Packaged backend did not become ready:` with empty stderr.
- Original evidence: `.orkestrator/review-artifacts/review-validation-b0c05d8b-b766-4f6d-a373-7333fcae7234/validation-04.stderr.txt`,
  lines 2043–2077. The retained workspace log at
  `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.SSasyB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  reports the CLI package's 467 passed, 6 skipped and 2 failed cases.
- Isolated owner rerun: `mise run test:logged -- --name address-cli-diagnostics -- bun --cwd=packages/cli test tests/cli.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed in 6.3 s (exit 0). The logged runner deleted passing output, so no new
  assertion or test count is claimed. No CLI implementation or timeout changed.
- This establishes an intermittent readiness failure. The cause remains
  unproven; contention alone is not evidence that the aggregate failure is
  environmental. Review triage called these related through the README path,
  so the isolated pass does not replace the failed aggregate's evidence.
- Commit `5bec27835` was later reordered out of the X1 branch so the report
  deletion stays last; its code equals the branch's code before the fix commit
  that follows `f11de93f0`. That fix touches coordinator authority and the
  Claude read hook, not backend startup.
- Further reruns, 2026-11-05, after rebuilding `packages/cli` from the branch
  head: `mise run test:logged -- --name x1-cli-lifecycle-1 -- bun --cwd=packages/cli test tests/cli.test.ts --preload ../../tests/setup-node.ts --parallel=2 --only-failures`
  and the same as `x1-cli-lifecycle-2` both passed (exit 0, 3.8 s each), with the
  aggregate's worker count. Still open: the readiness failure has not been
  reproduced outside the concurrent aggregate.

## X1 preparation at e6d400a5a, 2026-11-05

The preserved `review-validation-cb344dc9-16d4-4c41-980a-8b2fc2a2e3b5/validation-04.stderr.txt`
again names both packaged-backend readiness tests (`starts and gracefully stops
the packaged backend`; `starts when the caller's environment already sets
NODE_ENV`) at their 20-second deadline. Original command: `mise run test:logged
-- --name review-default-tests -- mise run test`; scheduler-selected concurrent
workers, no reliable closing aggregate total. The unchanged owner passed with
`mise run test:logged -- --name recorded-cli-lifecycle -- bun test --cwd
packages/cli ./tests/cli.test.ts --parallel=1 --only-failures` in 6.6 s, exit 0.
Passing output was removed, so no new totals are claimed. No CLI or startup
code was repaired; this isolated pass does not replace the failed aggregate.

## Scheduling repair validation, 2026-11-09

Observed on `project-scheduling-ac146edab2ff-r1`, base
`3cf3dd7994cb36954f0670430216a71c7b6505d9`. The recurrence tool reported
case 0080 open against `origin/main` and directed recording a recurrence.

`mise run test:logged -- --name address-full-tests -- mise run test` failed
both readiness cases: `starts and gracefully stops the packaged backend`
(20,085.31 ms) and `starts when the caller's environment already sets NODE_ENV`
(20,020.30 ms), both with `Packaged backend did not become ready:` and no
stderr cause. Workspace had five worker slots alongside root (one), bridges
(two), protocol (one), and a five-worker browser run. CLI totals were 508
passed, eight skipped, two failed; 518 tests across 36 files, 48.69 s.
Evidence: workspace log under
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.mX02WE/`.

Two owning-file attempts also failed (11 passed, two failed): one without an
explicit preload, then the package's preload-aware command
`mise run test:logged -- --name cli-lifecycle-with-preload -- bun --cwd=packages/cli test tests/cli.test.ts --preload ../../tests/setup-node.ts --parallel=2 --only-failures`
(40.4 s). Artifact:
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.WtM5aA/cli-lifecycle-with-preload.log.gz`.

The second aggregate's complete CLI package passed (510 passed, eight skipped,
518 tests, 13.35 s). The exact preload-aware owning-file command above then
passed unchanged (exit 0, 6.6 s); passing output was deleted, so no isolated
total is claimed. No CLI implementation, assertion or deadline changed. This
establishes intermittence, not a cause or environmental exemption.
