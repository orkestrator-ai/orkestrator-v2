# Interrupted move recovery exceeds the test deadline

- **ID:** 0866
- **Status:** resolved
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

### Resolution — 2026-11-06

- **Status reason:** stale; a later change already fixed it. Every recorded
  failure of this case is Bun's generic 5,000 ms deadline cutting off real
  Git, worktree and submodule fixture work, which the owner does in seconds
  per case on a loaded macOS host. The last observation was on or before
  2026-10-27. On 2026-10-28 `beb1ec4c8` (#1365) moved
  `apps/backend/src/core/environment-move.test.ts` to the slow tier and gave
  it `setDefaultTimeout(30_000)`, which also covers its hooks. No five-second
  deadline has been recorded for this case since. The follow-on "unhandled
  error between tests" (a fixture removed under a still-running move) was a
  consequence of the deadline.
- **Change in this pass:** none.
- **Verification:** `mise run test:logged -- --name env-move-stress -- bun
  --cwd=apps/backend test ./src/core/environment-move.test.ts --parallel=1
  --rerun-each=2`: PASS in 46.4 s at load average about 22. The original
  failure was not reproduced.
- **Not covered:** the separate 2026-11-03 CI `ENOENT` in `cleanup retries
  preserve a new directory at the source pathname` is not a deadline; it
  stays open under [1106](1106-environment-move-git-fixtures-under-host-load.md).
