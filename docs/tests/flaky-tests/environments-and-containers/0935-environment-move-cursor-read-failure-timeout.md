# Environment move Cursor read-failure recovery exceeds the test deadline

- **ID:** 0935
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `Cursor read failure retains recovery until the store can follow the destination`
- **Owning file:** `apps/backend/src/core/environment-move.test.ts:1181`
- **Tested revision:** `bb28a04f8` on branch `todo-0041-control-mcp-voice-699c0075ce9c` (from `main` at `00a0cb82e`); the change touched only `packages/cli/examples`, its tests and docs, so the environment-move owner was unchanged.
- **Original command:** `mise run test` (the non-iOS suite), with the workspace, bridges and root groups running concurrently on the shared host while other worktrees were active.
- **Failure:** the default 5000 ms deadline at 5019.61 ms, followed by an unhandled error between tests: `The environment's worktree does not exist: /private/tmp/ork-env-move-…/trees/app-…` from `moveEnvironmentOnce` (`environment-move.ts:176`) after the timed-out test's fixture was removed.
- **Suite counts:** backend 11,432 passed, 89 skipped, two failed and one between-tests error across 11,523 tests in 680 files (661.83 s). The other backend failure was registered flake [0785](../coordinator-and-multi-review/0785-opencode-research-server-registration-timeout.md).
- **Unchanged reruns:** the case alone (`bun test src/core/environment-move.test.ts -t "Cursor read failure retains recovery"`) passed; the complete owning file (`bun test ./src/core/environment-move.test.ts`) passed 37 of 37 in 33.7 s.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Mqtkm2/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** concurrent host load delayed the Git/worktree fixture beyond Bun's generic five-second budget, the same family as [0695](0695-environment-move-no-tmux-timeout.md), [0248](0248-move-restart-recovery-submodule-timeout.md), [0291](0291-environment-move-submodule-aggregate-timeout.md) and [0621](0621-environment-move-nested-submodules-aggregate-timeout.md); not established. The later missing-worktree error is consistent with the timed-out body continuing after fixture cleanup.
- **Changes:** evidence only; the owning source, assertions, timeout and skips were not changed.
- **Next step:** the explicit environment-move fixture budget tracked under 0291 would cover this case too.
