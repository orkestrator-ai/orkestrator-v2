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

## Design recovery validation — 2026-10-23

- **Tested revision:** `79dfe3240` plus design renderer/lifecycle recovery fixes; this Mermaid owner was unchanged.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`, with workspace/root/bridges/protocol reservations of 4/1/2/1 slots and two backend workers, alongside other worktree validation.
- **Failure:** the watchdog measured 5493 ms against `< 5000 ms`; Bun reported 5688.12 ms for the test. Its expected render-timeout assertion passed.
- **Aggregate result:** exit 1 after 975.7 s. Backend reported 10,116 passed, 60 skipped and one failed across 10,177 tests in 586 files (911.92 s). Every other workspace package, root/support, bridges and protocol lockfile check passed. This was the aggregate's only failed test.
- **Initial owning-file rerun:** `mise run test:logged -- --name mermaid-watchdog-rerun -- bun test --cwd apps/backend ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures` also failed while the full suite remained active: 5619 ms against `< 5000 ms`, 5831.53 ms test duration, 12 passed and one failed across 13 tests (56.1 s logged).
- **Evidence:** aggregate `orkestrator-test-run.Tu6L7a/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; isolated `orkestrator-test-run.0sisyJ/mermaid-watchdog-rerun.log.gz`, below the host temporary directory.
- **Assessment:** the first isolated rerun does not independently establish a flake for this observation. Chromium startup or host scheduling contention remains a hypothesis. No assertion, timeout, skip or implementation in this owner changed.

After the aggregate finished, `mise run test:logged -- --name mermaid-watchdog-post-suite -- bun test --cwd apps/backend ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures` passed the complete unchanged 13-test owner, exit 0, in 27.4 s. This confirms an intermittent recurrence; the aggregate and initial isolated failures remain recorded above. The aggregate itself remains failed. No assertion, deadline or skip changed.

## Tool-fold coverage validation recurrence — 2026-10-23

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test` on `animate-tool-calls-9f849713d495-r1`.
- **Worker configuration:** Workspace/root/bridges/protocol groups reserved 4/1/2/1 worker slots; the backend used two isolated Bun workers. Other worktree validation and transcript browser checks shared the host.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.5bWdNz/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Failure:** The watchdog measured 5368 ms against the current `< 5000 ms` bound (5725.34 ms test duration); the expected render-timeout result assertion passed.
- **Owning-file rerun:** `mise run test:logged -- --name mermaid-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures` passed the complete unchanged file, exit 0 in 33.0 seconds.
- **Assessment:** Recurrence of the existing elapsed-time flake. Browser startup or scheduling contention remains a hypothesis; no assertion, deadline or skip changed.
- **Aggregate counts:** Backend 10,076 passed, 86 skipped and two failed across 585 files (650.46 seconds); the aggregate exited 1 after 959.6 seconds. The web suite passed 8,824 tests with 10 skips. The initial root group also caught an unsafe DOM absence assertion in the newly added unit coverage; that assertion was corrected, and its owning diagnostics guard passed separately. Bridges, protocol regeneration and all remaining workspace packages passed.

## Session lifecycle review validation — 2026-10-23

- `mise run test:logged -- --name repository-tests -- mise run test` used two backend workers while other worktree and browser validation ran. The unchanged watchdog owner measured 7144 ms against `< 5000 ms` (7609.90 ms test duration).
- `mise run test:logged -- --name mermaid-owner -- bun test --cwd apps/backend ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures` also failed: 12 passed, one failed, 13 tests in 78.56 s (78.6 s logged). It measured 7344 ms against `< 5000 ms` (7577.86 ms test duration). This run does not establish a passing isolated rerun; the timing failure remains unresolved.
- Evidence: `orkestrator-test-run.NMPAwO/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.gKgVC2/mermaid-owner.log.gz` under the host temporary directory. No implementation, assertion, deadline, or skip in this owner changed.

- Aggregate backend totals: 9909 passed, 60 skipped, three failed across 9972 tests in 576 files (968.42 s). The two other backend failures were reconciliation-backoff tests, tracked in 0229. The complete repository command exited 1 after 1022.1 s. Its initial web composer-layout and root bounded-diagnostics failures were corrected during this implementation; both complete controller owners and the diagnostics owner passed afterward.
