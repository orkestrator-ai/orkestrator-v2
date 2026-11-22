# Terminal history backward paging exceeds the aggregate deadline

- **ID:** 0954
- **Status:** resolved
- **Date observed:** 2026-10-26
- **Test:** `terminal history > pages fixed history backwards and rejects a cursor for another history`
- **Owning file:** `apps/backend/src/core/terminal-history.test.ts`
- **Original command:** `mise run test` (full suite) on `todo-0166-opencode-attach-prompt-0d17ce147985` at `ce1d6890e` (OpenCode attachment MIME and dispatch-failure outcome, CLI scenario toolchain install; no terminal, environment-move or shell-completion code changed), macOS 27.0 arm64, Bun 1.4.4, host load average 22 to 36 from other worktrees.
- **Failure:** the 5000 ms deadline expired at 5001.73 ms.
- **Aggregate:** Workspace group failed with backend 2 and CLI 1 failures (this case among them), all three five-second deadlines; web, desktop, web-public, protocol and toolchain passed; bridges and the Codex protocol lockfile passed; root failed only on the pre-existing duplicate flake number fixed by renumbering 0953.
- **Owning-file rerun:** `mise exec -- bun test --cwd apps/backend ./src/core/terminal-history.test.ts --parallel=1 --only-failures` passed unchanged (25 pass, 0 fail).
- **Evidence:** `orkestrator-test-run.fcOpb4/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.

The same file's normalization case times out the same way under load
([0213](0213-terminal-history-aggregate-timeout.md)); host load is the likely
cause, not a confirmed diagnosis. No test, timeout, assertion or skip changed.

## Resolution (2026-11-15)

- **Owner moved:** the test is now in `apps/backend/src/core/terminals/history-part-1.test.ts` (file split by `dc90609bf`, 2026-11-14).
- **Root cause:** the five-second default test budget under host load (5001.73 ms); the case itself has no deadline or sleep, and the part file sets no smaller budget.
- **Fix:** `tests/default-test-timeout.ts` (preloaded by `tests/setup-node.ts`) raises the default budget to a 60 s hang watchdog. No test change. Same cause as [0213](0213-terminal-history-aggregate-timeout.md).
- **Reproduced:** no — not reproduced; classified from the recorded duration.
- **Stress:** none for this case.
