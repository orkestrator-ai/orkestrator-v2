# Mermaid watchdog elapsed time under aggregate load

- **ID:** 0512
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `mermaid rendering > the external watchdog ends a blocked render within the deadline and the browser is gone`
- **Owner:** `apps/backend/src/core/transcript-artifacts/mermaid-render.test.ts:191`
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`.
- **Configuration:** workspace/root/bridge/protocol groups ran concurrently; backend used `--parallel=2`, root used one worker. Other worktrees and browser validation were active on the host.
- **Failure:** elapsed time was 9,214 ms against `< 9,000 ms`; Bun reported 9,602.18 ms for the test. The preceding expected render-timeout assertion passed.
- **Aggregate backend counts:** 9,748 passed, 67 skipped and two failed across 551 files in 631.17 seconds. The other failure was a staging regression test added while the initial run was in flight; its final focused run passed after the byte-accounting fix.
- **Evidence:** `orkestrator-test-run.3snvK0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; outer log `orkestrator-test-run.nnUZ5F/full-tests.log.gz`.
- **Owning-file rerun:** `mise run test:logged -- --name mermaid-watchdog-isolated -- bun test --cwd apps/backend ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures`.
- **Isolated result:** exit 0 in 30.7 seconds, with the complete owning file unchanged. No test was skipped, loosened, or changed.
- **Assessment:** confirmed intermittent elapsed-time failure. Chromium startup or host scheduling contention is plausible; this run does not establish the cause. Keep the existing deadline assertion.

## Structured review layout validation recurrence — 2026-10-21

- **Command:** `mise run test:logged -- --name complete-tests -- mise run test`;
  backend used two isolated workers in the four-slot workspace group while
  root/bridge/protocol groups, browser checks and other worktree validation ran.
- **Failure:** the watchdog test measured 9,480 ms against `< 9,000 ms`;
  Bun reported 9,740.09 ms. The expected render-timeout assertion passed.
- **Backend aggregate counts:** 9,765 passed, 67 skipped and one failed across
  9,833 tests in 551 files (639.74 s).
- **Evidence:** `orkestrator-test-run.RzbPLB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  under the host temporary directory.
- **Owning-file rerun:** `mise run test:logged -- --name mermaid-render-rerun -- bun --cwd=apps/backend test ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0, 52.5 s logged).
- **Assessment:** confirms the existing elapsed-time flake; host scheduling or
  browser startup contention remains plausible but unproven. No assertion,
  deadline or skip changed.

## MCP external-edit watch review fixes — 2026-10-22

- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`; workspace/root/bridges/protocol reserved 4/1/2/1 slots, with two isolated backend workers.
- **Failure:** the watchdog measured 9188 ms against `< 9000 ms` (9515.29 ms test duration). Its expected `render_timeout` result assertion passed.
- **Owning-file rerun:** `mise run test:logged -- --name mermaid-watchdog-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures` passed the complete unchanged file (exit 0, 35.2 s logged).
- **Evidence:** `orkestrator-test-run.jhZR27/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** confirmed recurrence. The host load average exceeded 50 during validation; browser startup or scheduling contention remains an unproven explanation. No assertion, deadline or skip changed.

The aggregate exited 1 after 822.1 s. Backend counts were 9918 passed, 80 skipped, three failed and two between-test errors across 10001 tests in 572 files (757.16 s). The other failures are recorded in 0248, 0512 and 0673; root firewall fixture timeouts are recorded in 0192. All other workspace packages, bridges and protocol regeneration passed.

## Sidebar main-merge validation — 2026-10-22

- `mise run test:logged -- --name merge-suite -- mise run test` against the initial `c17f1c8d5` merge reserved workspace/root/bridges/protocol workers 4/1/2/1. Backend reported 9,967 passed, 69 skipped, two failed and one error (556.4 s). This case measured 9,299 ms against the 9,000 ms bound (9,546.23 ms test duration).
- After refreshing the pending merge to `7e051d955`, `mise run test:logged -- --name merge-mermaid-owner -- bun test --cwd apps/backend ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 in 30.8 s.
- Evidence: `orkestrator-test-run.9ak22c/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory. Browser, Docker and another worktree's validation overlapped the initial aggregate. No assertion, deadline or skip changed; host contention remains a hypothesis.
