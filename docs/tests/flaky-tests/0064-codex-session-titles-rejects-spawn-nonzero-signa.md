# `Codex session titles > rejects spawn, nonzero, signal, and invalid-output failures and cleans temporary state` (`bridges/codex-bridge/src/session-titles.test.ts`)

- **ID:** 0064
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests-acp-image-fixes.log`
- **Worker configuration:** The bridge group ran `bun test bridges --parallel=2` while the workspace, root, and protocol-lockfile groups ran concurrently.
- **Failure:** `this test timed out after 5000ms` (duration: 6,205.38 ms).
- **Suite counts:** Bridge group: 2,394 total, 2,382 passed, 11 skipped, and 1 failed.
- **Isolated rerun:** `set -o pipefail; bun test ./bridges/codex-bridge/src/session-titles.test.ts 2>&1 | tee /tmp/orkestrator-session-titles-isolated-acp-image-fixes.log` -> 17 passed, 0 failed, 90 assertions in 6.70 seconds; the affected case passed in 1,918.92 ms.
- **Hypothesis:** The case intentionally exercises several child-process failure modes under one five-second outer budget. It exceeded that budget only while the bridge and root process-heavy suites overlapped and completed well inside it when isolated; neither session-title code nor its tests changed in this work.
