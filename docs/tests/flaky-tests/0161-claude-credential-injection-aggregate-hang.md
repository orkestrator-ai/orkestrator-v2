# Claude credential injection hang in the root group

- **ID:** 0161
- **Status:** open
- **Date observed:** 2026-09-24
- **Tests:** no single case reported; the file was still running when the
  group watchdog fired
- **Files:** `tests/unit/claude-credential-injection.test.ts`
- **Original command:**
  `mise run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`
  on branch `20260924-133604-380b3ff31967` (design-space implementation)
- **Worker configuration:** root group alone, `--parallel=4`.
- **Failure:** `[orkestrator-test-runner] No output for 300000ms; terminating
  the group process tree`, with
  `tests/unit/claude-credential-injection.test.ts (386s)` listed as still
  running. No `(fail)` lines were reported before the watchdog.
- **Isolated rerun:** `bun test tests/unit/claude-credential-injection.test.ts`
  passed 28 of 28 in 0.44 s. The same file passed in the preceding full
  `mise run test` run on the same branch.

## Current assessment

A file that finishes in under a second alone and stalls for minutes under
`--parallel=4` points to contention on a shared resource (credential or
keychain helpers, temp directories) rather than an assertion failure. The
branch under test did not touch credential code. Keep open until a recurrence
captures which case stalls.
