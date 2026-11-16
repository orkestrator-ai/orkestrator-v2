# GitHub PAT transfer fixture's `git init` killed under aggregate load

- **ID:** 0885
- **Status:** resolved
- **Date observed:** 2026-10-25
- **Test:** `PAT creation pushes to its private repository and PAT discovery clones it, despite host SSH preferences`
- **File:** `apps/backend/src/core/github-project-credentials.integration.test.ts`
- **Change under test:** todo 0121 (Claude plugin MCP servers in the editor), which does not touch GitHub credentials or the git runner.
- **Original command:** `cd apps/backend && bun test --preload ../../tests/setup-node.ts src tests --parallel=4` (four backend workers, no other suite running; the host also ran an isolated `dev:test` profile).
- **Aggregate result:** a `beforeEach`/`afterEach` hook timed out at 5,003.81 ms, followed by an unhandled `CommandFailedError` from `git init --bare --initial-branch=main <tmp>/ork-github-transfer-*/remote.git` with `signal: "SIGTERM"`, `exitCode: null`, `timedOut: false`. Backend totals: 11,302 passed, 85 skipped, 13 failed.
- **Unchanged owner rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/github-project-credentials.integration.test.ts` from `apps/backend` passed (5 pass, 0 fail).
- **Hypothesis:** the fixture's `git init` did not finish inside the five-second hook under four-worker load, and the hook's teardown killed it, which surfaced as an unhandled rejection. Unproven; no implementation, assertion, timeout or skip changed.

## Resolution (2026-11-15)

- **Root cause:** the `beforeEach` fixture's `git init --bare` was starved past Bun's 5 s hook budget; the SIGTERM (`timedOut: false`) was the runner killing the hook's dangling process, not the command's own 60 s timeout.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup.ts`, `tests/setup-node.ts`), raises Bun's default per-test and hook budget from 5 s to 60 s (a hang watchdog only). The hooks in `apps/backend/src/core/github-project-credentials.integration.test.ts` pass no timeout and contain no inner deadline below the `runCommand` default of 60 s.
- **Reproduced:** no — the 5 s default budget was not exhausted before the change under the contention runner; the post-change run below shows only the current state. Base `a8b89f1541e7abb6af36d45121593ae14640a3ca`.
- **Stress:** `mise run test:logged -- --name f3-a-batch2 -- bun scripts/test-under-contention.ts --core 10 --burners 6 -- bun --cwd=apps/backend test --preload ../../tests/setup-node.ts ./src/core/host-maintenance-tasks.test.ts ./src/core/fix-path.test.ts ./src/core/github-project-credentials.integration.test.ts --rerun-each=3` passed.
