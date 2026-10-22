# Environmental, not flaky: `tests/unit/electron/*` on a host without `tmux`

- **ID:** 0109
- **Status:** environmental
- **Date observed:** 2026-08-07
- **Observation:** on a macOS host with no usable `tmux` binary, the root group takes roughly 1,035 s instead of its normal runtime and reports a handful of timeouts whose wall time is 900 s or more. Which tests fail varies between runs: `live session read paths > does not drop a back-to-back turn while the prior notification is pending`, `Electron backend command registry > backend-owned diff statistics > clears published counts when a repository config retarget cannot be scanned`, and `remote gateway > serializes invoke results once and keeps command metrics private and bounded` in one run; three different `tmux-backend`/`commands` tests in another.
- **Evidence:** the preceding output shows `spawn ... ENOENT` from `apps/backend/src/core/tmux.ts:331`. The affected files pass in isolation (`bun test tests/unit/electron/{tmux-backend,commands,backend-process,commands-io-coverage}.test.ts --parallel` -> 564 passed, 1 skipped, 0 failed in 66.95 s), and a fresh `origin/main` worktree reproduces the same shape, so this is not attributable to any working change.
- **Guidance:** do not record a new flake entry for these unless they fail on a host where `tmux` is installed and the root group runs in its normal time.
