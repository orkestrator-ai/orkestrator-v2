# `environment status and settings commands > preserves an admitted container start while its container is not yet persisted` (`tests/unit/electron/commands.test.ts:16388`)

- **ID:** 0123
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests.log`
- **Worker configuration:** The root and agent-support group ran concurrently with the workspace, bridge, and protocol-lockfile groups under `scripts/test-all.ts`'s bounded worker pools.
- **Failure:** `error: Timed out waiting for active start to finish` from the file's own `waitForCondition` helper (`commands.test.ts:1115`), reached through `withFakeGh` -> `withFakeDocker` (duration: 3,090.51 ms).
- **Suite counts:** Root and agent-support group: 3,657 total, 3,655 passed, 1 skipped, 1 failed across 145 files.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/electron/commands.test.ts` -> 398 passed, 1 skipped, 0 failed, 2,385 assertions in 89.34 seconds; the target passed.
- **Hypothesis:** The case drives fake `gh` and `docker` child processes and polls for the start to settle on a wall-clock budget, so it is contention-sensitive in the same way as the tmux clusters above. Observed while the only source change was in `bridges/acp-bridge`, which this test never loads. A recurrence should capture whether the admitted-start latch or only the poll budget was late before changing the command's behavior.
