# Container exec survives a failing logout hook (tests/unit/electron/commands-container-exec.test.ts)

- **ID:** 0154
- **Status:** open
- **Date observed:** 2026-09-21
- **Original command:** `mise run test`
- **Worker configuration:** Root and agent-support group with 3 Bun workers
- **Failure:** `Electron backend command registry > survives a login shell whose logout hook fails` exhausted its 30-second test timeout (reported duration: 30,012.99 ms). The aggregate subsequently reported an unhandled `git init -b work .` failure because the current working directory no longer existed.
- **Suite counts:** 4,348 total, 4,343 passed, 2 skipped, 3 failed, 1 unhandled error
- **Isolated rerun:** `mise run test:logged -- --name container-exec-isolated -- bun test ./tests/unit/electron/commands-container-exec.test.ts --parallel=1 --only-failures` → passed in 0.8s
- **Hypothesis:** The timeout and missing-working-directory error are sensitive to aggregate concurrency or cleanup ordering. The owning file completed unchanged in under one second in isolation; the aggregate evidence indicates a timed-out fixture may have removed a temporary working directory while another asynchronous setup still referenced it.
