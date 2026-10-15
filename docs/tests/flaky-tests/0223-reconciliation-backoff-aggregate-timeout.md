# Environment reconciliation backoff times out in the aggregate

- **ID:** 0223
- **Status:** open
- **Date observed:** 2026-10-13
- **Test:** `Electron backend command registry > backs off failed reconciliation for 30 seconds and clears the floor after success`
- **File:** `apps/backend/tests/commands-registry-environments-create.test.ts`
  (observed at its earlier path, `tests/unit/electron/commands-registry-environments-create.test.ts`)
- **Original command:** the testing guide's GNU-tool PATH with
  `mise run test:logged -- --name full-suite -- mise run test`.
- **Worker configuration:** standard workspace/root/bridges/protocol slots
  2/3/2/1; root files ran in three isolated Bun workers. Browser validation
  also ran on this host.
- **Failure:** five-second timeout, reported at 5005.15 ms, followed by a
  late fixture assertion error between tests.
- **Suite counts:** root/support 5,073 total, 5,041 passed, 24 skipped,
  eight failures and three additional errors across 256 files (375.09 seconds).
- **Isolated rerun:**
  `mise run test:logged -- --name reconciliation-backoff-isolated -- bun test ./tests/unit/electron/commands-registry-environments-create.test.ts --parallel=1 --only-failures`
  passed unchanged, exit 0, in 48.2 seconds. The aggregate workspace group
  and other individual-file reruns were still running on the host.
- **Failure evidence:**
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.bM95Aj/root-and-agent-support-tests.log.gz`.
- **Hypothesis:** the aggregate run exhausted the outer five-second budget;
  the owning file passed without sibling files in its Bun process. The stalled
  await and the root cause remain unconfirmed. No timeout, assertion or skip
  was changed.

Case 0202 tracks a different test in the same file.
