# Test-suite ownership Git scan aggregate timeout

- **ID:** 0502
- **Status:** open
- **Date observed:** 2026-10-19
- **Test:** `test suite ownership > ownership is derived from the scripts that run, not restated beside them`
- **Owner:** `tests/unit/test-suite-ownership.test.ts`
- **Scope:** `origin/main` at `cd443028` merged into pre-merge HEAD `d897a4eb`; the owning test and runner were unchanged.
- **Original command:** the testing guide's macOS GNU-tool PATH prefix with `/opt/homebrew/bin:/usr/bin` ahead of ambient shims, `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots, alongside component-browser, isolated-stack browser and build validation.
- **Failure:** the 5000 ms deadline expired at 5002.10 ms while `buildOwnership` was enumerating repository paths through `git ls-files`.
- **Isolated rerun:** the same PATH with `mise run test:logged -- --name merge-test-ownership-owner -- bun test ./tests/unit/test-suite-ownership.test.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0, 1.4 seconds logged).
- **Suite counts:** root/support reported 3146 passed, one skipped and one failed across 3148 tests in 148 files (329.96 seconds); the group finished in 330.0 seconds.
- **Evidence:** `orkestrator-test-run.tW4jss/root-and-agent-support-tests.log.gz` below the host temporary directory after aggregate completion.
- **Hypothesis:** repeated Git subprocess startup and repository enumeration may exceed the fixed deadline under concurrent load; no cause is established. No implementation, assertion, timeout or skip changed.

The later corrected aggregate (`merge-final-tests`) passed the complete root/support group unchanged: 3147 passed, one skipped, no failures (181.02 seconds execution; 267.5 seconds including its reservation wait). The final aggregate's two backend intermittent failures are recorded in [0500](0500-agent-mail-main-merge-validation.md).
