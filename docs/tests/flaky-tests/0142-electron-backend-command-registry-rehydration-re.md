# `Electron backend command registry > rehydration resumes only persisted cleanup after a merge was already confirmed` (`tests/unit/electron/commands-registry-environments.test.ts`)

- **ID:** 0142
- **Status:** open
- **Date observed:** 2026-09-07
- **Original command:** `bun run test` (full four-group concurrent suite) on `fix-session-wakeup-2275ef14bae5-r1`, the same run as the tmux entry above
- **Worker configuration:** the aggregate root/agent-support group, `--parallel` with the planned root worker pool.
- **Failure:** the case failed in the aggregate group; the run recorded no assertion text for it beyond the failure itself.
- **Isolated rerun:** `bun test tests/unit/electron/commands-registry-environments.test.ts -t "rehydration resumes only persisted cleanup after a merge was already confirmed"` → passed three times in a row at `d80bbd4c` (1,057 ms, 941 ms, 1,075 ms).
- **Owning file alone:** `bun test tests/unit/electron/commands-registry-environments.test.ts` → 136 passed, 8 failed in 19.20 s, and **this case passed**. All eight failures are worktree-creation cases failing on `fatal: could not create leading directories of '.../workspaces/remote-base-...': Read-only file system`, which is the agent sandbox denying writes outside the worktree rather than a defect. That run is therefore not evidence about this case either way.
- **Aggregate rerun:** the 2026-09-07 `bun run test` recorded in the tmux entry above did not reproduce this case; the group's only failure was the unrelated `tests/unit/bridge-packaging.test.ts` module-load `ENOENT`.
- **Retraction:** an earlier revision of the tmux entry above described this case as "a deterministic pre-existing failure rather than a flake" and used that to justify filing no entry. That is withdrawn — the case has not failed once outside the single aggregate run, so the determinism claim was unsupported.
- **Attribution:** the change in flight touches `bridges/claude-bridge` only and cannot reach the Electron command registry.
- **Hypothesis:** none yet. One aggregate-only observation with three clean isolated reruns is consistent with the contention pattern the tmux clusters show, but a recurrence needs to capture the assertion that actually failed before this can be attributed.
