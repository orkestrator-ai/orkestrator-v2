# GitHub PAT transfer fixture's `git init` killed under aggregate load

- **ID:** 0885
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `PAT creation pushes to its private repository and PAT discovery clones it, despite host SSH preferences`
- **File:** `apps/backend/src/core/github-project-credentials.integration.test.ts`
- **Change under test:** todo 0121 (Claude plugin MCP servers in the editor), which does not touch GitHub credentials or the git runner.
- **Original command:** `cd apps/backend && bun test --preload ../../tests/setup-node.ts src tests --parallel=4` (four backend workers, no other suite running; the host also ran an isolated `dev:test` profile).
- **Aggregate result:** a `beforeEach`/`afterEach` hook timed out at 5,003.81 ms, followed by an unhandled `CommandFailedError` from `git init --bare --initial-branch=main <tmp>/ork-github-transfer-*/remote.git` with `signal: "SIGTERM"`, `exitCode: null`, `timedOut: false`. Backend totals: 11,302 passed, 85 skipped, 13 failed.
- **Unchanged owner rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/github-project-credentials.integration.test.ts` from `apps/backend` passed (5 pass, 0 fail).
- **Hypothesis:** the fixture's `git init` did not finish inside the five-second hook under four-worker load, and the hook's teardown killed it, which surfaced as an unhandled rejection. Unproven; no implementation, assertion, timeout or skip changed.
