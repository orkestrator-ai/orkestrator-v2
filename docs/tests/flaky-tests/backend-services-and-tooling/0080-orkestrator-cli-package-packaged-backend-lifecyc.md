# `orkestrator CLI package` packaged-backend lifecycle (`packages/cli/tests/cli.test.ts`)

- **ID:** 0080
- **Status:** resolved
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
