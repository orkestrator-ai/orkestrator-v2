# Container exec survives a failing logout hook (apps/backend/tests/commands-container-exec.test.ts)

- **ID:** 0154
- **Status:** resolved
- **Date observed:** 2026-09-21
- **Original command:** `mise run test`
- **Worker configuration:** Root and agent-support group with 3 Bun workers
- **Failure:** `Electron backend command registry > survives a login shell whose logout hook fails` exhausted its 30-second test timeout (reported duration: 30,012.99 ms). The aggregate subsequently reported an unhandled `git init -b work .` failure because the current working directory no longer existed.
- **Suite counts:** 4,348 total, 4,343 passed, 2 skipped, 3 failed, 1 unhandled error
- **Isolated rerun:** `mise run test:logged -- --name container-exec-isolated -- bun test ./apps/backend/tests/commands-container-exec.test.ts --parallel=1 --only-failures` → passed in 0.8s
- **Hypothesis:** The timeout and missing-working-directory error are sensitive to aggregate concurrency or cleanup ordering. The owning file completed unchanged in under one second in isolation; the aggregate evidence indicates a timed-out fixture may have removed a temporary working directory while another asynchronous setup still referenced it.

## Resolution (2026-11-15)

- **Root cause:** The test ran real login shells against fake Docker under `ASYNC_TEST_BUDGET_MS`, then 30 s; the root aggregate starved it past that budget.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. `ASYNC_TEST_BUDGET_MS` in `apps/backend/tests/command-fixtures.ts` is now 60 s, matching the preload, as a hang watchdog; the test has no inner deadline.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-a -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 15 --burners 6 -- bun test --preload ../../tests/setup-node.ts <the twelve commands-* owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 736 passed, 2 failed, both `serves the Files panel from the scan the badge already ran`, which stays open in [9854](9854-electron-diff-statistics-aggregate-timeout.md); no other case failed.
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
