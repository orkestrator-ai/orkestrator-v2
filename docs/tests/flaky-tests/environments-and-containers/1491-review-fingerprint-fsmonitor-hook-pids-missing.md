# Fingerprint budget fires before the blocking fake process writes its pid file (apps/backend/src/core/review-worktree-fingerprint.test.ts)

- **ID:** 1491
- **Status:** resolved
- **Test:** `stops a blocked git and its descendant at its budget (bun)` (since 2026-11-15; first observed as `timeout reaps a blocking fsmonitor hook and descendants before fallback (node)`)
- **Date observed:** 2026-10-31; reopened 2026-11-15
- **Original command:** `mise run test`
- **Worker configuration:** backend workspace `bun test` at 4x parallel, on mbp3 with other workers running at the same time
- **Failure:** `ENOENT` opening `.git/hook-pids` in the test's temporary repository (duration: 2.35 s)
- **Suite counts:** backend 11778 total, 11673 passed, 103 skipped, 2 failed
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/review-worktree-fingerprint.test.ts` from `apps/backend`, three times → passed each time (15 pass, 0 fail)
- **Hypothesis:** the test shortens the status timeout to 1500 ms and then reads the pid file the blocking hook writes. The assertions before that read passed, so the fingerprint and its fallback ran, but no pid file existed: the hook appears not to have written it before the timeout fired. Not reproduced under controlled load. The same test passed in the run before it. The change on the branch (retiring the legacy close fallback) does not touch this code.

### Resolution — 2026-11-06

- **Status reason:** stale. The test no longer exists. `b4a64b73e` (#1883,
  "bound and serialize review worktree probes", 2026-11-06) changed the
  review worktree fingerprint so that it never runs the worktree's fsmonitor
  hook: its Git calls pass `--no-optional-locks -c core.fsmonitor=false`.
  The same commit replaced `timeout reaps a blocking fsmonitor hook and
  descendants before fallback` with `never runs the worktree's fsmonitor hook
  or takes optional locks`. That removed the blocking hook, the 1.5 s status
  timeout and the `.git/hook-pids` read that raced it. No version of the test
  file after `22c9612a9` mentions `hook-pids`.
- **Root cause (historical, unproven):** the hook-pid file was read after a
  1.5 s timeout that could fire before the blocking hook had started and
  written its PID under load. The path no longer exists to test.
- **Change in this pass:** none.
- **Verification:** `mise run test:logged -- --name env-fingerprint -- bun
  --cwd=apps/backend test ./src/core/review-worktree-fingerprint.test.ts
  --parallel=1 --rerun-each=5`: PASS in 65.2 s.

### Reopened — 2026-11-15

- **Recurrence check:** `mise run flaky:recurrence -- 1491 --base 30b38f696
  --registry-ref origin/main` → "resolved, and the base contains its fix
  (b4a64b73e1, 22c9612a90). This is a real recurrence". The 2026-11-06
  resolution removed the fsmonitor-hook test, but its successor in the same
  file fails the same way: a pid file the blocking fake process writes is
  missing after the probe's budget fired.
- **Test:** `stops a blocked git and its descendant at its budget (bun)`,
  `apps/backend/src/core/review-worktree-fingerprint.test.ts:273`.
- **Observed on:** mbp3 (macOS, arm64), branch
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
- **Hypothesis (unconfirmed):** the same race as the original failure. The
  probe runs with `budget-ms=500`. The fake Git writes `status-pid` only after
  the shell has started, matched the `--show-toplevel` call and forked
  `sleep`. Under load the 500 ms budget can expire, and kill the group, before
  that `printf` runs, so the probe still reports `timeout` but no pid file
  exists. A fix would wait for the pid file (or another signal from the fake
  Git) before the budget is armed, or pass the test when the budget fires
  before the fake Git started, rather than raising the budget.
- **Numbering note:** this was first recorded on the branch as a new case,
  9991, which was outside the branch's reserved flake range (9850–9859, all
  already taken). It is recorded here instead because the recurrence check
  matches this case; 9991 never reached `main`.

### Resolution — 2026-11-19

- **Status:** resolved. Base `fe9d1f5d6`.
- **Root cause (reproduced):** the probe arms its budget when it spawns the
  fake Git, not when the fake Git's shell has started. On a loaded host the
  budget can expire, and the probe kill the group, before the shell has forked
  `sleep` and written `status-pid`. The probe still correctly reports
  `timeout`, but the test then reads a pid file that never existed. This is a
  harness race, not a product defect: the probe's budget and group kill
  behaved as specified.
- **Reproduction:** prefixing the fake Git with `sleep 1;` (the losing side
  delayed past the 500 ms budget) failed both interpreters with the recorded
  `ENOENT` opening `.git/status-pid`:
  `mise run test:logged -- --name fp-repro -- bun --cwd=apps/backend test ./src/core/review-worktree-fingerprint.test.ts -t "stops a blocked git"`
  → 0 pass, 2 fail.
- **Fix:** the test retries with longer budgets (500 ms, then 2 s, then 5 s)
  only when the pid file is absent. Every attempt must still end as a
  `timeout` within its budget plus 7.5 s, and the attempt that finds the pid
  file still has to show both the fake Git and its descendant stopped. The
  usual path stays at 500 ms; the test budget is 45 s for three bounded
  attempts.
- **Verification:** the same `sleep 1;` injection with the fix: PASS (6.6 s,
  both interpreters, through the 2 s attempt). Stress without the injection:
  `mise run test:logged -- --name fp-stress -- bun scripts/test-under-contention.ts --burners 4 -- bun --cwd=apps/backend test ./src/core/review-worktree-fingerprint.test.ts --rerun-each=5`
  → PASS (97.3 s; macOS, burners unpinned).

Each attempt now gives the fake Git its own PID record. The
fixture writes the pair to a temporary file and renames it into place, so
expiry between those steps leaves the final record absent and allows a
retry. The owning test file passed. A separate probe held the first attempt
after writing its temporary file and verified that both Bun and Node retried,
then confirmed that the two processes from the successful attempt stopped.
