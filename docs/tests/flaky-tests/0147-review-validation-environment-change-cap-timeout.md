# Review-validation environment-change cap timeout

- **ID:** 0147
- **Status:** resolved
- **Date observed:** 2026-09-19
- **Test:** `drops overlong drifted paths and makes a 1024-path cap observable`
  (`apps/backend/src/core/review-validation-worker.test.ts:317`)
- **Original command:** `mise run test`
- **Worker configuration:** workspace group under the host-capacity runner; the
  backend package used one Bun worker while the root and bridge groups also ran.
- **Failure:** Bun's generic `this test timed out after 5000ms` after 6,194.28
  ms, followed by one between-tests error from the interrupted child process.
- **Suite counts:** 3,421 total, 3,418 passed, 2 skipped, 1 failed, 1 error.
- **Isolated rerun:** `mise run test:logged -- --name review-validation-worker
  -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts
  ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures` →
  passed in 18.2 s.
- **Hypothesis:** the case creates 1,040 files and then runs the real validation
  worker and Git scan; aggregate host contention made that legitimate work
  exceed Bun's default outer timeout.
- **Root cause:** the test had no explicit budget despite intentionally doing
  enough filesystem and subprocess work to exceed five seconds on a loaded host.
- **Fix:** give this case a 30-second outer budget without changing its worker,
  cap, ordering, or truncation assertions.
- **Verification:** the owning file passed after the fix in 20.3 s; `mise run
  test` then passed all four groups under the full eight-worker host budget in
  142.3 s, and `mise run test:all` subsequently passed those groups plus iOS.
