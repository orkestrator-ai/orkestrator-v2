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

## Recurrence on 2026-10-18 (reopened)

`mise run test:logged -- --name full-suite -- mise run test` on branch
`qualify-annotation-live-implement-0330a0bacc01` (`50c26708`, which does not
touch the Codex bridge) timed out in this case at 15,052.48 ms against its
15,000 ms timeout, in the bridges group (408.8 s) on a heavily loaded macOS
host. Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Zq7Cut/bridges.log.gz`. The unchanged owning file passed
alone (9 passed, 98 ms; and
`mise run test:logged -- --name iso-codex-runtime-env -- bun test --cwd bridges/codex-bridge ./src/runtime-env.test.ts --parallel=1 --only-failures`).
Reopened: the earlier resolution recorded no cause, and the larger timeout
did not hold.

