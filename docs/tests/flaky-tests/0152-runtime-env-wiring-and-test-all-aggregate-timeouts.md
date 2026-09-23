# Runtime environment wiring and test-all aggregate timeouts

- **ID:** 0152
- **Status:** open
- **Date observed:** 2026-09-23
- **Tests:** 19 cases in `container runtime environment wiring` (for example
  `Codex configuration copy helpers enforce file and directory bounds` and
  `runtime helper creates a bash env file with expected contents and
  permissions`) and 5 in `scripts/test-all.ts` (for example `serializes full
  suites across linked worktrees and cleans stale leases`)
- **Files:** `tests/unit/runtime-env-wiring.test.ts`,
  `tests/unit/test-all.test.ts`
- **Original command:** `mise run test` (first full run on branch
  `slash-commands-support-3b13a4bc3b08-r1`)
- **Worker configuration:** the root and agent-support group ran concurrently
  with the bridge and workspace groups.
- **Failure:** every case failed with "this test timed out after 5000ms"
  (one after 15,000 ms). Root group: 4,317 pass, 4 skip, 26 fail; the other two
  failures in that run were real regressions, fixed before the rerun.
- **Isolated rerun:**
  `bun test tests/unit/runtime-env-wiring.test.ts tests/unit/test-all.test.ts`
  passed 106 of 106. A second full `mise run test` passed the root group
  entirely.

## Current assessment

Shell-spawning cases hitting Bun's default five-second budget together, then
passing alone and in the next aggregate run, points to host contention rather
than a defect in the tests. Related history: 0078 (a single runtime-env-wiring
timeout) and 0055 (test-all concurrency). Keep open until a recurrence narrows
the cause.
