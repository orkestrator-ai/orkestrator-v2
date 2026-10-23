# Application logging shutdown deadline fails under load

- **ID:** 0696
- **Status:** open
- **Date observed:** 2026-10-23
- **Test:** `application logging shutdown > quits anyway when the flush outlives its deadline`
- **File:** `apps/desktop/electron/application-logging.test.ts`
- **Original command:** the workspace group of `mise run test` (`bunx turbo run build test:workspace … --concurrency=3`, `ORKESTRATOR_TEST_WORKERS=3`), run directly while other worktrees held the machine at a load average of about 70.
- **Failure:** failed after 68 ms; `fixture tree digest > names every class of change a coordinator could make` (0258) also timed out in the same run.
- **Isolated rerun:** `bun test ./electron/application-logging.test.ts` from `apps/desktop`: 25 pass, 0 fail.
- **Assessment:** a deadline-based test sensitive to scheduler delay; unconfirmed.
