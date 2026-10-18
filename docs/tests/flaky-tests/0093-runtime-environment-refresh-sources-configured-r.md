# `runtime environment refresh > sources configured runtime helper and applies refreshed shell environment` (`bridges/codex-bridge/src/runtime-env.test.ts:179`)

- **ID:** 0093
- **Status:** open
- **Date observed:** 2026-08-11
- **Original command:** `bun test bridges --parallel`
- **Worker configuration:** Bun's parallel bridge-suite worker pool
- **Failure:** The test exceeded Bun's 5,000 ms timeout.
- **Suite counts:** 2,280 total, 2,268 passed, 11 skipped, 1 failed across 65 files with 7,400 assertions.
- **Isolated rerun:** `bun test ./bridges/codex-bridge/src/runtime-env.test.ts` -> 10 passed, 0 failed with 30 assertions in 102 ms; the affected test passed in 6.06 ms.
- **Hypothesis:** The helper-spawn test is sensitive to aggregate bridge-suite scheduling or process-start latency. It completed far below the timeout in isolation, but this single observation does not identify a narrower production or test defect.

## Recurrence — 2026-10-18

- **Command:** `mise run test:logged -- --name usage-all-tests -- mise run test`
- **Worker configuration:** Aggregate bridge group: two package tasks, one Bun worker per package, alongside workspace and root groups.
- **Failure:** The same helper-spawn case timed out at its current 15,000 ms deadline (15,000.41 ms). No bridge implementation changed in this usage-cache fix.
- **Evidence:** `orkestrator-test-run.BopZMS/bridges.log.gz` (Codex bridge runtime environment case).
- **Isolated rerun:** `mise run test:logged -- --name codex-runtime-env-rerun -- bun test ./bridges/codex-bridge/src/runtime-env.test.ts --preload ./tests/setup-node.ts --parallel=1 --only-failures` passed unchanged in 0.3 s.
- **Disposition:** Reopened. No timeout or assertion was relaxed; aggregate process-start latency remains the working hypothesis.
