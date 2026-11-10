# Input-stamp import ownership tests time out on a busy host

- **ID:** 5103
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Test/file:** the 18 tests of `import ownership failures`, for example `linked sums stamp cannot block changed tree import` and `failed removal retries (whole tree missing=true)`, apps/backend/tests/portable-inputs-stamps.test.ts.
- **Original command:** `mise run test` during review preparation of the store writes branch, then `mise run test:logged -- --name stamps-owner -- bun --cwd=apps/backend test tests/portable-inputs-stamps.test.ts --parallel=2 --only-failures`, macOS arm64, Bun 1.4.4, 18 CPUs.
- **Failure:** `^ this test timed out after 5000ms`, followed by `entrypoint failed:` with empty stderr, because the runner killed the boot it was waiting on. Owner file alone: 34 pass, 16 fail in 374 s at load average 28–42 with four aggregate runs from other worktrees on the host. An earlier owner run on this branch had 49 pass, 1 fail. Every failure was in this one group.
- **Isolated rerun:** at load average 9–19 the owner file passed, all 50 tests in 117.8 s, once the deadlines below were in place.
- **Root cause:** the deadline, not the code under test. Each test runs two to four real boots of the `docker/entrypoint.sh` setup section. Timed at load average 28, 26 boots averaged 1,959 ms, and the longest took 5,979 ms, so one boot can exceed the runner's default 5 s by itself. Every other test in the file that boots carries a 60 s deadline; this group, added in #1742, carried none. No storage code runs: the file constructs no storage service, and neither `docker/entrypoint.sh` nor `portable-inputs.ts` changed on the branch where this was reported, so the import path through `storage-context.ts` is not the cause.
- **Fix:** the group uses the file's 60 s deadline. The assertions and the entrypoint are unchanged.
- **Verification:** under a bounded synthetic load of 30 CPU-bound processes, the group with the old deadlines had 0 pass, 18 fail (91.3 s); the group with 60 s deadlines had 18 pass, 0 fail (141.4 s, load average 44–58).
- **Not explained:** one earlier owner run with a temporary 30 s deadline had 42 pass, 8 fail, on the last eight tests of the file. Its host load was not recorded, so it cannot be attributed after the fact. No hang was seen in any later run. The same 42 pass, 8 fail on the last eight tests recurred at the 60 s deadline in [5561](5561-portable-input-stamps-spawn-latency-deadline.md), during the 04:07–04:18 run, when spawn time was not sampled either. Slow process spawning was measured during a later failing run with a different result (31 pass, 19 fail); neither 42-pass, 8-fail run has a spawn-time measurement.


## Owner moved to the slow tier and consolidated (2026-11-10)

`apps/backend/tests/portable-inputs-stamps.test.ts` now runs only in the slow tier (`scripts/test-tiers.ts`; `mise run test:slow`, and CI's `test:full` on every pull request), so the default `mise run test` no longer runs it. The file was also consolidated: one fixture build per file restored per test, the per-provider `logins` tests merged into two scenarios covering all five providers, and the `import ownership failures` matrix reduced from 15 tests to 5. Entrypoint boots went from 129 to 59 and the file alone from about 115 s to about 55 s. Some test names cited above no longer exist; search the file for the scenario rather than the old name.
