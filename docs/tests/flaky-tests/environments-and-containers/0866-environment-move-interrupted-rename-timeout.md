# Interrupted move recovery exceeds the test deadline

- **ID:** 0866
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `interrupted move recovery > adopts a completed rename and abandons an unfinished copy`
- **Owning file:** `apps/backend/src/core/environment-move.test.ts`
- **Tested revision:** `e8fa18152` plus the leaf-node Control MCP parity changes; the environment-move owner and environment move code were unchanged.
- **Original command:** `mise run test:logged -- --name full-test -- mise run test`, on a shared host with other worktrees running.
- **Failure:** the default 5000 ms deadline at 5014.23 ms.
- **Suite counts:** backend 11,448 passed, 84 skipped, one failed across 11,533 tests in 678 files (702.01 s).
- **Unchanged owning-file rerun:** `bun test --cwd apps/backend ./src/core/environment-move.test.ts --parallel=1` passed the complete file (37 of 37).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.A7erFE/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** host load delayed the Git/worktree fixture past its deadline, as in [0695](0695-environment-move-no-tmux-timeout.md); not established.
- **Changes:** evidence only; no source, assertion, timeout or skip changed. The original aggregate remains failed.
