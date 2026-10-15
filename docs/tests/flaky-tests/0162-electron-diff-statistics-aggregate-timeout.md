# `Electron backend command registry > backend-owned diff statistics` scans time out under aggregate load (`apps/backend/tests/commands-integration.test.ts`)

- **ID:** 0162
- **Status:** open
- **Date observed:** 2026-09-25
- **Tests:** `computes counts for a tracked local environment and announces them`
  (8,100 ms) and `serves the Files panel from the scan the badge already ran`
  (7,710 ms), both reported as exceeding the 5,000 ms test timeout.
- **Original command:** `mise run test:changed` (recurring-processes step 10;
  root and agent-support group ran next to the workspace and bridge groups)
  on a shared host at load average 30–41. The root group reported 766 passed
  and 2 failed.
- **Isolated rerun:** `mise run test:logged -- --name root-diffstats -- bun test ./apps/backend/tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed.
- **Hypothesis:** real git diff scans under heavy host contention exceed the
  generic five-second budget. The change under validation (bridge lifecycle,
  ACP disconnect detection, reconnect backoff) touches no diff-statistics
  code.

## Recurrence — 2026-10-15 (tmux socket cleanup)

`mise run test:logged -- --name full-tests -- mise run test` reserved 4/1/2/1
workspace/root/bridge/protocol slots on a shared 18-slot host. The backend
package used two isolated Bun workers. `computes counts for a tracked local
environment and announces them` exceeded its five-second timeout at 5180.68 ms.
The backend group reported 7711 passed, 39 skipped and 2 failed across 423 files;
the other failure was a shutdown/deletion test that also failed alone.
Evidence:
`/tmp/orkestrator-test-run.VSQjnP/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

`mise run test:logged -- --name diff-statistics-isolation -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
passed the unchanged owning file alone (exit 0) in 28.9 seconds. The tmux change
does not modify diff scanning. Host contention remains an unconfirmed
hypothesis; no timeout, assertion or skip was changed.

## Recurrence 2026-10-12

- **Tests:** `deleting an environment drops its counts from the snapshot`
  (5,287 ms), `does not mark the counts approximate for an ordinary worktree`
  (7,251 ms), `does not resurrect deleted tracking from a stale
  reconciliation` (7,856 ms), `enables git's scan caches on a newly created
  worktree` (6,930 ms), and `persists safe cleanup failure details and permits a
  backend deletion retry` (7,663 ms, same file).
- **Original command:** `mise run test:logged -- --name full-tests-2 -- mise run test`;
  root group 4992 passed, 24 skipped, 19 failed, 3 errors across 253 files in
  390 seconds. The same suite earlier the same day did not fail these cases.
- **Isolated rerun:** `bun test ./apps/backend/tests/commands-integration.test.ts`
  passed 55 of 55.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.j4rNKa`.
- The change under validation (disk usage reporting, worktree locations) adds
  a recorded worktree root to deletion cleanup; the isolated pass covers those
  deletion paths.

## Recurrence 2026-10-13 (GitHub clone review fixes)

- **Original command:** GNU-tool `PATH` prefix from the testing guide with
  `mise run test:logged -- --name fix-full-tests -- mise run test`.
- **Worker configuration:** three root workers beside two workspace and two
  bridge workers; browser checks also ran on the host.
- **Tests:** `computes counts for a tracked local environment and announces them`
  (5,905.74 ms), `serves the Files panel from the scan the badge already ran`
  (5,239.82 ms), and `refreshes a tracked environment on explicit request`
  (5,392.15 ms), all exceeding the five-second deadline.
- **Root-suite counts:** 5,047 total, 5,018 passed, 24 skipped, 5 failed. One of
  those failures was a new bounded-diagnostics assertion, corrected in this
  change; the other unrelated failure was a firewall fixture timeout.
- **Isolated rerun:** `mise run test:logged -- --name isolate-diff-stats -- bun test ./apps/backend/tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed in 30.5 seconds.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.FOIo01/root-and-agent-support-tests.log.gz`.
- **Hypothesis:** the same scan timeouts recur under aggregate contention;
  the owning file passes unchanged alone. The root cause remains unconfirmed.

## Recurrence during merge conflict validation (2026-10-13)

- **Original command:** the GNU-tool `PATH` prefix from the testing guide with
  `mise run test:logged -- --name merge-suite -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol used 2/3/2/1 slots;
  root files used three isolated Bun workers. Browser validation also ran.
- **Root-suite counts:** 5,073 total, 5,044 passed, 24 skipped, 5 failed and
  1 additional error across 256 files in 238.08 seconds. Workspace, bridges,
  protocol and browser groups passed.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.6mi44l/root-and-agent-support-tests.log.gz`
  and the adjacent `summary.json`.
- **Test:** `computes counts for a tracked local environment and announces them`
  exceeded its five-second deadline at 5,812.47 ms.
- **Isolated rerun:** the same GNU-tool PATH with
  `mise run test:logged -- --name merge-diffstats-isolated -- bun test ./apps/backend/tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0) in 24.6 seconds.
- **Hypothesis:** the aggregate deadline failures match earlier observations;
  unchanged owning files pass alone. Contention may contribute, but the root
  cause remains unconfirmed. No assertion, timeout or skip was changed.

## Recurrence during main merge validation — 2026-10-15

- **Tests:** `enables git's scan caches on a newly created worktree` timed
  out at 5,662.64 ms; `deleting an environment drops its counts from the
  snapshot` timed out at 5,175.95 ms. Both exceeded the 5,000 ms deadline.
- **Original command:** `PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" mise run test:logged -- --name merge-main-full-suite -- mise run test`.
- **Worker configuration:** backend package `--parallel=2`, two workspace
  package tasks, alongside the other aggregate groups and other host validations.
- **Suite counts:** backend 7,745 passed, 39 skipped, 6 failed and one
  between-tests error across 7,790 tests in 427 files (361.91 seconds).
  The whole aggregate finished in 594.9 seconds; root and protocol groups passed,
  while the bridges group also reported the ACP hook timeout tracked as 0219.
- **Evidence:** `/tmp/orkestrator-test-run.jDL6Dp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** the documented GNU-tool PATH with
  `mise run test:logged -- --name commands-integration-isolated -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file in 47.2 seconds.
- **Disposition:** aggregate-only deadline failures recorded without changing
  assertions, deadlines or skips. Host contention is a hypothesis, not a proven
  cause.
