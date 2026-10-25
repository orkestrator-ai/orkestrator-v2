# Unattributable `bun run test` failure — aggregate output truncated on exit (`scripts/test-all.ts`)

- **ID:** 0074
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail && bun run test 2>&1 | tee /tmp/fix2-full-tests.log`, and an immediate repeat into `/tmp/fix3-full-tests.log`.
- **Worker configuration:** the standard four concurrent groups from `buildConcurrentGroups`, then iOS.
- **Failure:** both runs exited 1 with **no identifiable failing test**. The log ended mid-line — `(pass) claude-client > listSessions > returns sessions array on success [0.09error: script "test" exited with code 1` — after 2,628 and 2,653 lines (278 KB) against the 46,000+ lines a passing run produces. In the second run the workspace group had already printed `PASS`, so the failure was in a group whose block never reached the log at all.
- **Suite counts:** not recoverable; the group summaries were in the discarded output.
- **Isolated rerun:** every suite passed individually — workspace group direct (`turbo run test:workspace`, 12/12 successful in 2m10s), and the aggregate itself passed on the next two runs (`bun scripts/test-all.ts > file`, exit 0, 46,489 lines; `bun run test | tee`, exit 0, 46,172 lines).
- **Root cause:** of the *lost evidence*, not of the underlying failure. `main()` ended a failing run with `process.exit(status)`. Group output is buffered and printed as one multi-megabyte block, and a pipe — which is exactly what the documented `| tee` workflow makes stdout — accepts that write asynchronously. `process.exit` tears the process down mid-flush. A direct probe confirmed the size: writing 3,000,015 bytes then calling `process.exit(1)` delivered 196,608 bytes (one pipe buffer) through a pipe and dropped the tail marker, while `process.exitCode = 1` delivered all 3,000,015 bytes and preserved the status.
- **Fix:** `scripts/test-all.ts` now sets `process.exitCode` and lets the runtime drain stdout and exit on its own. `tests/unit/test-all.test.ts` covers the default exit path directly, and `tests/unit/monorepo-scripts.test.ts` asserts `process.exit(status)` never returns.
- **Verification:** `bun run test 2>&1 | tee` -> exit 0 with the complete 46,172-line log. The underlying failure has not recurred in the runs since; if it returns, its group block will now survive to the log and can be recorded here properly.
