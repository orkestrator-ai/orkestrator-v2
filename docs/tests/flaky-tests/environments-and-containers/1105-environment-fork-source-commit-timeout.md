# Local fork from the source commit exceeds the test deadline under load

- **ID:** 1105
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `fork_environment > starts a local fork from the source commit rather than origin/main`
- **Owning file:** `apps/backend/tests/commands-environment-fork.test.ts:302`
- **Tested revision:** `5eb3f9037` on branch `test-temp-directory-4cd0548cf2b5-r1` (from `main` at `ce205ad34`). The branch changes test teardown and temporary-directory handling; it does not touch environment forking or this file.
- **Original command:** the 0247 qualification sweep, `TMPDIR=<empty private dir> mise exec -- bun run --cwd apps/backend test:workspace` (two workers), run directly rather than through Turbo, on macOS 27.0 arm64 while other worktrees' suites loaded the host (load average up to 37 during the session).
- **Failure:** `this test timed out after 5000ms`, reported at 10030.64 ms, after `killed 2 dangling processes`.
- **Suite counts:** backend 11,992 passed, 115 skipped, 13 failed across 12,120 tests in 719 files (557.10 s). The other twelve were Git-heavy deadlines in `environment-move.test.ts` and `worktree-snapshots-git.test.ts` (see [1106](1106-environment-move-git-fixtures-under-host-load.md), [0947](0947-worktree-git-aggregate-timeouts.md) and [0957](0957-worktree-index-and-shared-ref-aggregate-timeouts.md)).
- **Unchanged rerun:** `mise run test:logged -- --name rerun-commands-environment-fork -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-environment-fork.test.ts` passed the complete owner in 5.4 s.
- **Evidence:** the sweep's own log, `backend.log` under `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/ork0247-qual/logs/` (outside the logged runner, so not compressed).
- **Hypothesis:** host contention delayed the fork's Git subprocesses past Bun's generic five-second deadline, like the environment-move family; not established.
- **Changes:** evidence only; the test, its timeout and skips were not changed.
