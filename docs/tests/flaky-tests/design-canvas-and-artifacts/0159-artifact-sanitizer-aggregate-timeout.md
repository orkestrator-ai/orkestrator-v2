# `agent-test artifact sanitizer > redacts gateway credentials from plain results and Playwright traces`

- **ID:** 0159
- **Status:** resolved
- **Date observed:** 2026-09-22
- **Original command:** `mise run test`
- **Worker configuration:** root and agent-support group, `3x PARALLEL`, alongside workspace and bridge groups
- **Failure:** five-second timeout (5,001 ms); cleanup then removed `results.json` before the unfinished test read it. The group had 4,411 passed, 2 skipped, and 2 failed across 207 files.
- **Isolated rerun:** `mise run test:logged -- --name artifact-sanitizer-isolated -- bun test ./e2e/agent-testing/artifact-sanitizer.test.ts --parallel=1 --only-failures` passed.
- **Hypothesis:** external `zip` and `unzip` calls plus archive sanitization can exceed Bun's generic five-second test budget under aggregate load.
- **Root cause:** aggregate scheduling can exhaust the generic five-second outer budget while these real archive processes run.
- **Fix:** set a 20-second outer budget for this archive-processing test in `e2e/agent-testing/artifact-sanitizer.test.ts`.
- **Verification:** isolated file passed after the change; the next `mise run test` passed all four groups.
