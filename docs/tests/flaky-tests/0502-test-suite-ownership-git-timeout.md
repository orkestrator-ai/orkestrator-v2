# Test-suite ownership Git scan aggregate timeout

- **ID:** 0502
- **Status:** resolved
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

## Resolution — 2026-10-20

- **Root cause:** `buildOwnership` asked Git separately for every selector and workspace prefix (`git ls-files -co --exclude-standard -- <prefix>`), and two tests each rebuilt it. One file run spawned 67 synchronous Git subprocesses, each walking the working tree for untracked files, so the test's cost scaled with process-spawn and filesystem latency and could cross the five-second deadline under aggregate load.
- **Fix:** `tests/unit/test-suite-ownership.test.ts` now lists the repository once per file run (`git ls-files -co --exclude-standard`) and answers each prefix by filtering that list for the exact path or paths beneath it, matching a literal Git pathspec; wildcard selectors still go to Git. Ownership is derived once and shared by the tests that use it. Assertions, selectors, the "matches nothing" check and the timeout are unchanged.
- **Equivalence:** for all 33 prefixes the old implementation queried, the in-memory filter returned exactly the same paths as `git ls-files -- <prefix>`.
- **Verification:** Git subprocesses per file run went from 67 to 1; the file alone went from about 0.9–1.4 s to 0.14 s. Six concurrent copies × 5 rounds with every core saturated by busy loops: the owning test went from median 0.88 s / max 1.26 s to median 0.2 ms / max 3.5 ms, and the sibling ownership test from median 1.28 s / max 2.22 s to median 0.10 s / max 0.14 s; 30/30 runs passed after the fix, plus 20/20 sequential runs. `oxlint`, `oxfmt --check` and `tsc -p tests/tsconfig.json` are clean.
