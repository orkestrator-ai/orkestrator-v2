# Consolidation subprocess-bounds fake CLI never records its pid under load

- **ID:** 9820
- **Status:** open
- **Date observed:** 2026-11-15

Tests: `subprocess bounds > a claude CLI that ignores SIGTERM times out, is
killed and leaves no directory` and `subprocess bounds > a codex CLI that
ignores SIGTERM times out, is killed and leaves no directory` in
`apps/backend/src/core/review/evaluation-drivers.test.ts`.

Observed on `static-html-reports-776fd527af5f-r1` at `c9c14eef6` (a merge of
`origin/main` at `b6044774c` into the branch), merge base `b6044774c`. The
branch changes no backend code: its diff against `origin/main` is
`apps/web-public/`, `apps/web/vite-plugin-renderer-security.ts`, its test,
`apps/web/src/components/chat/rich/static-html-frame-source.ts`,
`e2e/public-site/` and documentation, none of which this test's imports
reach. No group index entry matched either test; this is a new observation,
not a counted recurrence.

Original command:
`mise run test:logged -- --name review-default-tests-rerun -- mise run test`
on macOS (load average about 8.5 when the run finished). Both cases failed in
about 405 ms at line 306 with `ENOENT: no such file or directory, open
'<tmp>/mre-drivers-test-*/pid'`: `runConsolidation` had already returned
`{ ok: false, failure: "timed out" }` (the 300 ms `timeoutMs`), but the fake
CLI had not written its `pid` file. The backend group counted 2 fail out of
18,621 tests across 1,309 files (245.5 s).

The aggregate runner reran the unchanged owning file alone: 22 pass, 0 fail
in 3.1 s. The fake writes `cwd` and `pid` as the first lines of a `/bin/sh`
script, so a plausible but unconfirmed cause is that under load the shell had
not reached those lines before the 300 ms timeout killed its process group.
If that is it, the product behaviour is correct (a CLI that has not started
is still timed out and killed) and the test's premise, that the fake records
its pid within 300 ms, is what fails. Not shown. No deadline, assertion or
implementation changed. Evidence: `orkestrator-test-run.DsnGMR` under the
host temporary directory.

## Agent-accounts folder validation (2026-11-20)

- **Reviewed commit:** `8d3a72226b0c87a5bc32bb73ad068e784b982344`, base
  `e102a0dd55fc6360de61959c4ff843c9032cadfe`. The recurrence check against
  `origin/main` confirmed the case was open.
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`,
  with backend package tests using two isolated Bun workers.
- **Failure:** the Codex case in `apps/backend/src/core/multi-review-evaluation-drivers.test.ts`
  failed at 404.10 ms with `ENOENT` reading the fake CLI's `pid` file.
  Backend reported 19,725 passed, 212 skipped and four failed across 1,400 files.
- **Complete owner rerun:** from `apps/backend`,
  `bun test ./src/core/multi-review-evaluation-drivers.test.ts --preload ../../tests/setup-node.ts --only-failures --parallel=1`
  passed 22 tests (2.6 s logged). The fake process's start-up timing remains
  a possible cause.
- **Evidence:** `orkestrator-test-run.HiqeYP` in the host temporary directory,
  including the workspace log and `rerun-apps-backend-src-core-multi-review-evaluation-drivers-test-ts.log.gz`.


## Merge-base validation review (2026-11-21)

The default review command, `mise run test:logged -- --name review-default-tests -- mise run test`,
ran against `6ba08a5191274f5771fda72b7608422120683dc7` with base
`8a199a67e91fc54d858a8235393c4e1c0d9c1924` on macOS. The recurrence check
confirmed this case was open. In the two-worker backend suite, both cases
failed to read the fake CLI's `pid` file with `ENOENT` at 405.94 ms (Claude)
and 405.77 ms (Codex). The backend group reported five failures across
20,309 tests and 1,427 files in 297.68 s.

The runner retried `apps/backend/src/core/review/evaluation-drivers.test.ts`
alone. It passed all 22 tests in 3.25 s using
`bun test ./src/core/review/evaluation-drivers.test.ts --preload ../../tests/setup-node.ts --only-failures --parallel=1`
from `apps/backend`. The workspace and isolated rerun logs are in
`orkestrator-test-run.x1Z7Da` under the host temporary directory.

## Launch-flicker worktree validation (2026-11-22)

`mise run test:logged -- --name full-suite -- mise run test` ran on macOS
against a working tree based on `62c894364` (merge base with `origin/main`,
`62c894364`); the change under test touched the startup-launch renderer and
`launch-activity-reconciler.ts`, not the review drivers. The recurrence check
(`mise run flaky:recurrence -- 9820 --base 62c894364`) confirmed this case was
open. Both cases failed again with the missing fake-CLI `pid` (`ENOENT` at
`evaluation-drivers.test.ts:306`) at 405.81 ms (Claude) and 405.23 ms (Codex),
in a backend group of 20,332 tests across 1,428 files (304.14 s).

The runner's isolated rerun of `apps/backend/src/core/review/evaluation-drivers.test.ts`
passed all 22 tests in 3.15 s. Logs are in `orkestrator-test-run.Xmufl2` under
the host temporary directory.

## Result-tool bracket-repair worktree (2026-11-22, second run)

A focused run of the backend `workflows` and `review` folders,
`mise run test:logged -- --name workflows-review -- bun test --cwd=apps/backend ./src/core/workflows ./src/core/review --parallel=4 --only-failures`,
ran on macOS against a working tree based on `af78acfbf` while another
worktree's full suite was running on the host. The change under test touched
`workflows/result-json-text.ts`, `workflows/result-tools.ts` and
`review/consolidation-example.ts`, not the review drivers. The recurrence check
(`mise run flaky:recurrence -- 9820 --base af78acfbf`) confirmed this case was
open. Both cases failed again with the missing fake-CLI `pid` at
`evaluation-drivers.test.ts:306` (404.45 ms Claude, 403.24 ms Codex); the run
reported 1,606 pass, 1 skip and 2 fail across 71 files (53.90 s).

`bun test ./src/core/review/evaluation-drivers.test.ts` from `apps/backend`
then passed all 22 tests alone. Logs are in `orkestrator-test-run.RkBCPb`
under the host temporary directory.

## Recurrence on 2026-11-23

- **Branch and base:** `upgrade-packages-0a3b6266bb77-r1`, a dependency-upgrade batch that does not touch the review drivers, on base `307d19317`. `mise run flaky:recurrence -- 9820 --base 307d19317` confirmed the case was open.
- **Original command:** `mise run test:logged -- --name full-suite-3 -- mise run test` on macOS arm64, with other worktrees holding test slots.
- **Failure:** Only the Claude case failed this time: `subprocess bounds > a claude CLI that ignores SIGTERM times out, is killed and leaves no directory` (404.74 ms) hit `ENOENT` reading the fake CLI's `pid` at `evaluation-drivers.test.ts:306`.
- **Suite counts:** The backend package reported 20,212 pass, 212 skip and 2 fail across 1,431 files (the other failure was the unrelated `tests/storage-core-coverage.test.ts`, which also fails on the base).
- **Isolated rerun:** The aggregate runner reran the file alone and it passed 22 of 22 tests in 4.4 s.
- **Aggregate evidence:** `orkestrator-test-run.DMIe79/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and its `rerun-*evaluation-drivers*` log in the host temporary directory.
