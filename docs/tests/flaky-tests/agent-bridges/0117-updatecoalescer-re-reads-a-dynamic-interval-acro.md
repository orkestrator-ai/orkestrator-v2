# `UpdateCoalescer > re-reads a dynamic interval across schedules in both directions` (`bridges/codex-bridge/src/messages/coalescer.test.ts`)

- **ID:** 0117
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-c9efefa1-full-tests.log`
- **Worker configuration:** The bridge group ran `bun test bridges --parallel` concurrently with the workspace, root, and protocol-lockfile groups.
- **Failure:** Expected `publishedAt` to contain 3 timestamps but received 4 at `coalescer.test.ts:90` (duration: 90.32 ms).
- **Suite counts:** Bridges: 2,383 total, 2,371 passed, 11 skipped, 1 failed across 67 files.
- **Isolated rerun:** `bun test ./bridges/codex-bridge/src/messages/coalescer.test.ts --parallel` -> 9 passed, 0 failed, 23 assertions in 268 ms; the target passed in 78.26 ms.
- **Hypothesis:** The test coordinates multiple real elapsed-time intervals and observed one additional publish only under aggregate scheduling. A deterministic scheduler or callback boundary should be evaluated if it recurs; the available evidence does not establish a production coalescing defect.
