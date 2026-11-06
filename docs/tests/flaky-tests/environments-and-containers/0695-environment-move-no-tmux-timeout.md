# Environment move without tmux exceeds the test deadline

- **ID:** 0695
- **Status:** resolved
- **Date observed:** 2026-10-23
- **Test:** `move_environment > moves with no tmux sessions or hook backups and preserves workspace settings`
- **Owning file:** `apps/backend/src/core/environment-move.test.ts`
- **Tested revision:** `79dfe3240` plus the design recovery fixes in this change; the environment-move owner was unchanged.
- **Original command:** `mise run test:logged -- --name design-recovery -- bun --cwd apps/backend test ./src/core/design/renderer.test.ts ./src/core/design/lifecycle.test.ts ./src/core/design/records.test.ts --parallel=3 --only-failures`. This argument order invoked the backend's package test script, which included all of `src tests`, with three isolated workers. Other worktrees and the repository-wide validation were active on the shared host.
- **Failure:** the default 5000 ms deadline at 5014.62 ms, followed by an unhandled `ENOENT` in `worktree-paths.ts:52` after the timed-out test removed its temporary directory.
- **Suite counts:** 10,159 passed, 86 skipped, one failed and one between-tests error across 10,246 tests in 589 files (469.91 s).
- **Unchanged owning-file rerun:** `mise run test:logged -- --name environment-move-rerun -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed the complete file, exit 0, in 32.4 s.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.LQHXO7/design-recovery.log.gz`.
- **Hypothesis:** concurrent host load delayed the Git/worktree fixture beyond its deadline; not established. The later missing-directory error is consistent with the timed-out body continuing after fixture cleanup.
- **Changes:** evidence only; the owning source, assertions, timeout and skips were not changed. The original broad backend run remains failed. The focused design recovery checks and disposable real-stack design checks passed separately.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** single observation. Same family as [0248](0248-move-restart-recovery-submodule-timeout.md), [0291](0291-environment-move-submodule-aggregate-timeout.md) and [0621](0621-environment-move-nested-submodules-aggregate-timeout.md): Git-heavy environment-move fixtures under Bun's generic five-second budget. No later change gives these cases a budget.
- **Next step:** give the environment-move fixture cases an explicit budget, as [0130](0130-electron-command-registry-fixture-shim-timeouts.md) did for the command-registry shims, and track that work under 0291.

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
