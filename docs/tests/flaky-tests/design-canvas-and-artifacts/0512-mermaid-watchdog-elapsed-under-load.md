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

## Transcript scroll validation — 2026-10-24

- `mise run test:logged -- --name final-repository -- mise run test`, alongside focused Playwright and unit runs in the same worktree. The unchanged watchdog owner measured 5375 ms against `< 5000 ms` (5698.97 ms test duration).
- `mise run test:logged -- --name backend-mermaid -- bun --cwd=apps/backend test src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (13.6 s logged, exit 0).
- Evidence: `orkestrator-test-run.4LYtCC/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory. No implementation, assertion, deadline, or skip in this owner changed.

## Media preview review validation — 2026-10-24

- **Original command:** `mise run test:logged -- --name media-preview-suite -- mise run test` on `image-access-error-3ee36b3f7d06-r1`; workspace/root/bridges/protocol reserved 4/1/2/1 slots, with two backend workers. Other worktree validation and an isolated browser suite shared the host.
- **Failure:** the unchanged watchdog owner measured 5410 ms against `< 5000 ms` (5693.79 ms test duration). Its expected render-timeout result assertion passed.
- **Owning-file rerun:** `mise run test:logged -- --name media-preview-mermaid-owner -- bun test --cwd apps/backend ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures` passed the complete unchanged 13-test owner, exit 0, in 36.9 seconds.
- **Evidence:** `orkestrator-test-run.RsxwH7/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.
- **Assessment:** recurrence of the existing elapsed-time flake. Host scheduling or Chromium startup contention remains a hypothesis. No assertion, deadline, skip or implementation in this owner changed. The initial root group also caught bounded-diagnostics violations in the new preview tests; those assertions were corrected and the diagnostics owner passed separately.

The aggregate exited 1 after 786.0 seconds. Backend totals were 10,569 passed, 77 skipped and 15 failed across 618 files (708.97 seconds): this watchdog and 14 unchanged OpenCode conformance cases, whose installed CLI reported 1.19.4 while the tests required 1.19.0. The complete conformance owner reproduced that mismatch alone (56 passed, 14 failed, 17.0 seconds). Web passed 9,140 tests with 10 skips; bridges, protocol regeneration and every other workspace package passed. The isolated browser suite passed 29 tests with 53 opt-in skips and reset its profile; targeted project-home/container preview checks passed at desktop and narrow widths and after reload.

After correcting the preview tests' diagnostics assertions, `mise run test:logged -- --name media-preview-root-isolated -- bun test ./tests/unit --parallel=1 --only-failures` passed the complete root unit suite (exit 0, 308.1 seconds). An extra `mise run test:unit` attempt, which omits module isolation, produced 41 failures and one between-test error; the unchanged Create Environment owner passed alone (37.6 seconds), and the complete isolated root run above passed. Those non-isolated results remain in `orkestrator-test-run.BMXKsO/media-preview-root-final.log.gz`; no unrelated test was weakened or skipped.

## Transcript scroll main merge — 2026-10-24

- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=f12cc5a5382417bf1bfbda2a7fd93e0d6013aa95 mise run test:logged -- --name merge-repository -- mise run test`, workspace/root/bridges/protocol 4/1/2/1 slots with two backend workers, alongside component and isolated-stack browser validation.
- **Failure:** elapsed 5778 ms against `< 5000 ms` (6018.47 ms test duration).
- **Complete unchanged owner:** `mise run test:logged -- --name merge-mermaid-owner -- bun test --cwd apps/backend ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures` passed, exit 0 (25.2 s logged).
- **Evidence:** host temporary artifact `orkestrator-test-run.k5J28D/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` after aggregate finalization. No implementation, assertion, deadline or skip changed.


## Coordinator adapter review — 2026-10-24

The aggregate repeated this case during coordinator adapter validation. Exact
commands, timing, owner rerun results and evidence are recorded in
[0725](../aggregate-validation-runs/0725-coordinator-adapter-review-validation.md).
The owning implementation, assertions, timeouts and skips were unchanged.

## Environment-list UI main merge — 2026-10-24

The aggregate recurrence passed in the complete unchanged owning-file rerun. Exact commands, durations, merge parents, aggregate results and evidence are retained in [0790](../aggregate-validation-runs/0790-environment-list-main-merge-validation.md). No implementation, assertion, timeout or skip changed.

## Resume cleanup coverage validation — 2026-10-25

Original command: `mise run test:logged -- --name cleanup-repository -- mise run test`, with workspace/root/bridge/protocol worker reservations 4/1/2/1 and component browser validation running concurrently. Aggregate evidence is under the host temporary directory, `orkestrator-test-run.TabHxj/`.

`mermaid rendering > the external watchdog ends a blocked render within the deadline and the browser is gone` measured 6,135 ms against the 5,000 ms elapsed bound (6,346.89 ms test duration).

The complete unchanged owner also failed: `mise run test:logged -- --name cleanup-mermaid-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures` reported 12 passed and one failed across 13 tests (72.22 s), measuring 7,281 ms against the same bound (7,588.19 ms test duration). Owner evidence: `orkestrator-test-run.UuiUGe/cleanup-mermaid-owner.log.gz` below the host temporary directory.

This observation establishes no new pass-alone confirmation or cause. The aggregate and owner remain non-green; no Mermaid implementation, assertion, timeout or skip changed.

## Recurrence 2026-10-25 (scheduled jobs)

`mermaid rendering > enforces source bytes, edges and SVG limits at and over the boundary` returned `render_timeout` (5000 ms parse/layout watchdog) instead of `package_size_exceeded` in the scheduled-jobs `mise run test` aggregate (8084 ms). The complete unchanged 13-test owner passed alone (`bun test --cwd apps/backend ./src/core/transcript-artifacts/mermaid-render.test.ts`).
Recurred after rebasing onto main `eda21487` (8347.60 ms aggregate); the unchanged owner passed alone (`mise run test:logged -- --name mermaid-owner -- bun test --cwd apps/backend ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1`, 24.1 s).

## Local preview discovery review — 2026-10-25

`mise run test:logged -- --name preview-repository -- mise run test` measured 8314 ms against the current `< 5000 ms` bound at `mermaid-render.test.ts:210` (8959.74 ms test duration). The backend used two isolated Bun workers alongside repository/browser validation on the shared host. The complete unchanged owner ran separately with `mise run test:logged -- --name preview-mermaid-owner -- bun test --cwd apps/backend ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures`: 12 passed, one failed (59.3 s), measuring 6109 ms against the same bound (6351.60 ms test duration). This recurrence remains non-green in the owner and is not newly classified as a flake. No Mermaid implementation, assertion, deadline or skip changed. Evidence: `orkestrator-test-run.0vNQwf/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.Wv984c/preview-mermaid-owner.log.gz` under the host temporary directory.

## Coordinator consistency validation — 2026-10-25

- **Command:** `mise run test:logged -- --name committed-consistency-suite -- mise run test`, with two isolated backend workers and concurrent worktree validations.
- **Failure:** the watchdog test measured 5772 ms against `< 5000 ms` at line 210 (test duration 6078.47 ms).
- **Complete unchanged owner:** `mise run test:logged -- --name mermaid-watchdog-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/mermaid-render.test.ts --parallel=1 --only-failures` passed, exit 0 in 42.9 seconds.
- **Evidence:** `orkestrator-test-run.iEyQ7i/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** another intermittent elapsed-time failure, confirmed by the unchanged owner's isolated pass. No artifact implementation, assertion, timeout or skip changed.
