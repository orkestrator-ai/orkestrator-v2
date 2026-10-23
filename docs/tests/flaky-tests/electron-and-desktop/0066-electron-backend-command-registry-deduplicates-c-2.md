# `Electron backend command registry > deduplicates concurrent background starts for one environment` (`tests/unit/electron/commands.test.ts`)

- **ID:** 0066
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/rev-full-tests.log`, and again in `/tmp/fix-full-tests.log`
- **Worker configuration:** the root and agent-support group ran concurrently with the workspace, bridges, and codex protocol-lockfile groups.
- **Failure:** `error: Timed out waiting for deduplicated background start to finish` raised by the file's own `waitForCondition` helper (`tests/unit/electron/commands.test.ts:1115`) after its 3,000 ms poll expired (durations 3,009.85 ms and 3,008.20 ms across the two aggregate runs). No assertion mismatch was reported.
- **Suite counts:** first aggregate: root and agent-support group 3,641 passed, 1 skipped, 1 failed, 16,428 assertions across 145 files in 290.05 seconds; all other groups passed. Second aggregate: same test failed alongside the tmux cluster above.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/electron/commands.test.ts --parallel 2>&1 | tee /tmp/rev-commands-isolated.log` -> 398 passed, 1 skipped, 0 failed, 2,385 assertions in 77.51 seconds.
- **Group rerun:** `bun test ./tests --parallel` -> 0 failed (see the cluster entry above).
- **Hypothesis:** the helper polls for the deduplicated start to settle on a fixed 3,000 ms wall-clock budget while the case also stands up a fake Docker and a fake `gh`. Under aggregate contention the supervised work completes later than that budget allows. The deduplication behaviour itself is what the case asserts, and it holds in both isolated and whole-group runs, so the budget rather than the product logic is the first thing to re-examine.
