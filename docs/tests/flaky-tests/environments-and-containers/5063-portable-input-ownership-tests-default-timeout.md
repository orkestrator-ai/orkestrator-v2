# Portable-input ownership tests hit Bun's 5 s default under aggregate load

- **ID:** 5063
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Tests:** `import ownership failures > linked sums stamp cannot block changed tree import`,
  `import ownership failures > unreadable sums stamp cannot block changed tree import`,
  `import ownership failures > failed single-file removal keeps its stamp for retry`.
- **Owning file:** `apps/backend/tests/portable-inputs-stamps.test.ts`.
- **Original command:** the review preparation's `mise run test` for the E7
  diff-scans branch (`review-validation-575573b4`, validation step 04), macOS,
  default aggregate reservations.
- **Failure:** each test timed out after 5,043–5,049 ms. The test file and
  `docker/entrypoint.sh` were unchanged by the branch. The triage marked them
  `related` only because the file imports `diff-stats-service.ts` through
  other modules.
- **Isolated rerun:** each failing test alone took 2.8 s, 5.4 s and 3.8 s of
  wall time, Bun's start-up included. The whole file passed alone (exit 0).
- **Cause:** every test in the `import ownership failures` block boots the
  real entrypoint setup section two or three times, but that block was the
  only one in the file without the 60 s budget the other boot tests pass. Bun's
  5 s default left no headroom once the aggregate loaded the host.
- **Fix:** `a7cce0038` gives the eight tests in that block the same
  `60_000` timeout as the rest of the file. No assertion changed.
- **Verification:** two copies of the whole file run at once, as extra load,
  `mise run test:logged -- --name portable-stamps-load-{a,b} -- bun test --cwd
  apps/backend ./tests/portable-inputs-stamps.test.ts --preload
  ../../tests/setup-node.ts --parallel=1 --only-failures`: both exit 0 in
  131.8 s.


## Owner moved to the slow tier and consolidated (2026-11-10)

`apps/backend/tests/portable-inputs-stamps.test.ts` now runs only in the slow tier (`scripts/test-tiers.ts`; `mise run test:slow`, and CI's `test:full` on every pull request), so the default `mise run test` no longer runs it. The file was also consolidated: one fixture build per file restored per test, the per-provider `logins` tests merged into two scenarios covering all five providers, and the `import ownership failures` matrix reduced from 15 tests to 5. Entrypoint boots went from 129 to 59 and the file alone from about 115 s to about 55 s. Some test names cited above no longer exist; search the file for the scenario rather than the old name.
