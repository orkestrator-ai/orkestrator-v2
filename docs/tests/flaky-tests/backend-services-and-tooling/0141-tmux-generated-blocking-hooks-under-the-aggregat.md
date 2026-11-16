# tmux generated blocking hooks under the aggregate run (`apps/backend/tests/tmux-commands.test.ts`)

- **ID:** 0141
- **Status:** resolved
  `Electron tmux backend command registration` timeout cluster and
  `Electron tmux backend command registration` agent MCP config and hook tests. Both were filed
  against the pre-split `tests/unit/electron/tmux-backend.test.ts` and both were marked resolved by
  the 2026-08-16 resolution sweep; the case moved to `tmux-commands.test.ts` in the split recorded
  in the file-ownership table above.
- **Date observed:** 2026-09-07
- **Original command:** `bun run test` (full four-group concurrent suite) on `fix-session-wakeup-2275ef14bae5-r1`
- **Worker configuration:** the aggregate root/agent-support group, `--parallel` with the planned root worker pool.
- **Failure:** `Electron tmux backend command registration > generated blocking hooks use an integer timeout and fail closed on expiry` (1,603.43 ms). The duration is well inside Bun's outer budget, so this recurrence is not the 5,000 ms timeout shape the two earlier entries recorded.
- **Suite counts:** root and agent-support group — 4,073 ran, 4,068 passed, 3 skipped, 2 failed. The run's other failure was `Electron backend command registry > rehydration resumes only persisted cleanup after a merge was already confirmed` in `apps/backend/tests/commands-registry-environments.test.ts`; it has its own entry below.
- **Isolated rerun:** `bun test apps/backend/tests/tmux-commands.test.ts -t "generated blocking hooks use an integer timeout and fail closed on expiry"` → passed in 2.3 s.
- **Aggregate rerun (2026-09-07, same tree at `d80bbd4c`):** `bun run test` did not reproduce this case at all. The root and agent-support group reported 4,067 passed, 3 skipped, 1 failed, 1 error across 189 files in 104.61 s, and its single failure was an unrelated module-load `ENOENT` in `tests/unit/bridge-packaging.test.ts` caused by an untracked `bridges/.claude/` directory the agent harness creates. So the aggregate group does not fail this case on every run, which is what keeps it classified as a flake.
- **Attribution:** the change in flight touches `bridges/claude-bridge` only and cannot reach the Electron tmux command registry. The isolated rerun passed against the same working tree.
- **Hypothesis:** unchanged from the earlier entries — real shim and tmux processes contend for host resources in the aggregate group. The sub-two-second duration here suggests an ordering or shim-availability race rather than budget exhaustion, so a recurrence should capture which shim invocation returned before asserting the fail-closed path.

## Resolution (2026-11-15)

- **Root cause:** the sub-two-second failure was an ordering race inside the test: the session poll loop could run during the hooks and drain the `timeout` files the test then counts (`readdir(.../timeout)` expected three). The earlier entries' five-second timeouts were the default budget.
- **Fix:** already in the tree. `49acbc388` (2026-10-22, after the last observation on 2026-09-07) holds the poll loop before its first tick (`pollLoopHeld`, injected through `sessionTiming.pollTick`) until the test has inspected the files, and the default budget is now a 60 s hang watchdog (`tests/default-test-timeout.ts`). No change in this pass.
- **Reproduced:** no — the race was not re-created against the pre-`49acbc388` test; the classification rests on the fix's mechanism matching the failure and there being no observation since.
- **Stress:** `mise run test:logged -- --name f2-cont-tmux -- bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/tmux-commands.test.ts -t "generated blocking hooks" --rerun-each=5` passed 5 of 5 (159 s).
