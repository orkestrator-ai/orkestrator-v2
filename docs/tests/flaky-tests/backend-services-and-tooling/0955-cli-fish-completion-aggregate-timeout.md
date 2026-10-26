# CLI fish completion execution exceeds the aggregate deadline

- **ID:** 0955
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `native shell completion execution > fish parses collisions, equals forms, list/duration values and short flags`
- **Owning file:** `packages/cli/tests/command-surface.test.ts`
- **Original command:** `mise run test` (full suite) on `todo-0166-opencode-attach-prompt-0d17ce147985` at `ce1d6890e` (OpenCode attachment MIME and dispatch-failure outcome, CLI scenario toolchain install; no terminal, environment-move or shell-completion code changed), macOS 27.0 arm64, Bun 1.4.4, host load average 22 to 36 from other worktrees.
- **Failure:** the 5000 ms deadline expired at 5008.78 ms (the case spawns `fish` repeatedly).
- **Aggregate:** Workspace group failed with backend 2 and CLI 1 failures (this case among them), all three five-second deadlines; web, desktop, web-public, protocol and toolchain passed; bridges and the Codex protocol lockfile passed; root failed only on the pre-existing duplicate flake number fixed by renumbering 0953.
- **Owning-file rerun:** `mise exec -- bun test --cwd packages/cli ./tests/command-surface.test.ts --parallel=1 --only-failures` passed unchanged (14 pass, 0 fail).
- **Evidence:** `orkestrator-test-run.fcOpb4/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.

Host load is the likely cause, not a confirmed diagnosis. No test, timeout,
assertion or skip changed.
