# Generation-bound container readiness fails in the aggregate

- **ID:** 0230
- **Status:** open
- **Date observed:** 2026-10-13
- **File:** `apps/backend/tests/container-readiness.test.ts`
  (observed at its earlier path, `tests/unit/electron/container-readiness.test.ts`)
- **Tests:**
  - `generation-bound readiness > a failed boot, an exited container and a timeout are typed and retryable`
  - `generation-bound readiness > a legacy image bypasses readiness, while an unanswered probe remains gated`
- **Original command:** the testing guide's GNU-tool PATH with
  `mise run test:logged -- --name full-suite -- mise run test`.
- **Worker configuration:** standard workspace/root/bridges/protocol slots
  2/3/2/1; root files ran in three isolated Bun workers. Browser validation
  also ran on this host.
- **Failures:** the first case timed out after 5001.05 ms with a late error
  between tests. The second returned `ContainerInitializationError` with
  `failureCode: container-exited` after 1845.12 ms.
- **Suite counts:** root/support 5,073 total, 5,041 passed, 24 skipped,
  eight failures and three additional errors across 256 files (375.09 seconds).
- **Isolated rerun:**
  `mise run test:logged -- --name container-readiness-isolated -- bun test ./tests/unit/electron/container-readiness.test.ts --parallel=1 --only-failures`
  passed unchanged, exit 0, in 2.5 seconds. The aggregate workspace group
  and reconciliation-backoff rerun were still running on the host.
- **Failure evidence:**
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.bM95Aj/root-and-agent-support-tests.log.gz`.
- **Hypothesis:** the aggregate timeout was followed by a late fixture
  rejection and an unexpected container-exited result. Passing the unchanged
  owner without sibling files establishes timing sensitivity, but does not
  establish whether the second failure was fallout from the first. No timeout,
  assertion or skip was changed.
