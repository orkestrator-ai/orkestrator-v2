# Review fingerprint budget fires before the blocked fake Git writes its pid file (apps/backend/src/core/review-worktree-fingerprint.test.ts)

- **ID:** 9991
- **Status:** open
- **Test:** `stops a blocked git and its descendant at its budget (bun)`
- **File:** `apps/backend/src/core/review-worktree-fingerprint.test.ts:273`
- **Date observed:** 2026-11-15, on mbp3 (macOS, arm64), branch
  `electron-window-request-adbadd631072-r1` (to-do 6303), base `30b38f696`.
  The branch changes only desktop native dialogs, an Electron spec and docs;
  it does not touch this test or the review fingerprint.
- **Original command:** `mise run test` (workspace group, backend `bun test`
  at the runner's default parallelism), during the 6303 Address Findings
  rerun.
- **Failure:** `ENOENT` opening `.git/status-pid` in the test's temporary
  repository, at line 306, after the earlier assertions (elapsed under 8 s,
  `CommandFailedError`, not `timedOut`, reason code `timeout`) passed.
  Duration 588.16 ms.
- **Suite counts:** the workspace group failed with this test as its only
  backend failure; the root group failed separately on
  `tests/unit/apt-packages-installer-plan.test.ts` (a deterministic macOS
  `PATH` problem, not a flake: the installer's fixed `PATH` omits
  `/opt/homebrew/bin/flock`).
- **Isolated reruns:**
  - The aggregate runner's own rerun of the file alone: passed (8.9 s).
  - `mise run test:logged -- --name fingerprint-alone -- bun --cwd=apps/backend test ./src/core/review-worktree-fingerprint.test.ts --parallel=1 --rerun-each=3`:
    107 pass, 1 fail, the same test with the same `ENOENT` (525.83 ms). This
    ran while `mise run test:agent:electron` was loading the same host (load
    average 9–11).
- **Hypothesis (unconfirmed):** the probe runs with `budget-ms=500`. The fake
  Git writes `status-pid` only after the shell has started, matched the
  `--show-toplevel` call and forked `sleep`. Under load the 500 ms budget can
  expire, and kill the group, before that `printf` runs, so the probe still
  reports `timeout` but no pid file exists. The test's comment assumes the
  first Git call is reliably running before the budget fires; a slow fork
  breaks that. A fix would wait for the pid file (or another signal from the
  fake Git) before the budget is armed, or pass the test when the budget
  fires before the fake Git started, rather than raising the budget.
