# Generation-bound container readiness fails in the aggregate

- **ID:** 0230
- **Status:** resolved
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

## Resolution (2026-11-15)

- **Root cause:** Fake-Docker readiness checks exceeded Bun's 5 s default under aggregate load; the test measures no time.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The owning file sets no smaller file, test or hook budget, and the failing test has no inner wall-clock deadline of its own.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-b -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 13 --burners 6 -- bun test --preload ../../tests/setup-node.ts <seventeen container, pipeline, move, worktree and native-agent owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 1,139 passed, 1 failed — `git fsmonitor > fixture repositories inherit fsmonitor off from the test preload` on its second rerun, which fails the same way without contention and with the unchanged file (`git-fsmonitor.test.ts` is not rerun-safe).
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
