# CLI fish completion execution exceeds the aggregate deadline

- **ID:** 0955
- **Status:** resolved
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

## Resolution (2026-11-15)

- **Root cause:** each fish completion spawns `fish` cold; under aggregate load the case used up Bun's 5 s default budget. Its inner `spawnSync` timeout of 4 s was a second wall-clock limit of the same kind.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup.ts`, `tests/setup-node.ts`), raises Bun's default per-test and hook budget from 5 s to 60 s (a hang watchdog only). `packages/cli/tests/command-surface.test.ts` sets no other test budget; the fish `spawnSync` timeout is now a 30 s hang watchdog on fish exiting.
- **Reproduced:** no — the 5 s default budget was not exhausted before the change under the contention runner; the post-change run below shows only the current state. Base `a8b89f1541e7abb6af36d45121593ae14640a3ca`.
- **Stress:** `mise run test:logged -- --name f3-a-batch -- bun scripts/test-under-contention.ts --core 10 --burners 6 -- bun test --cwd=packages/cli --preload ../../tests/setup-node.ts ./tests/command-surface.test.ts ./tests/fix-command.test.ts --rerun-each=3` passed. `fish` is not installed on this host, so the fish cases were skipped there; their change is unverified locally.
