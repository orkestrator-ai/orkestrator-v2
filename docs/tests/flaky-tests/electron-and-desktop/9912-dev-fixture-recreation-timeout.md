# Development fixture recreation timeout

- **ID:** 9912
- **Status:** resolved
- **Date observed:** 2026-11-09

Test: `disposable agent-test fixture > a registered project whose repository is gone is prepared again`
in `apps/desktop/scripts/dev/fixture.test.ts`.

Observed on `project-scheduling-ac146edab2ff-r1`, base
`3cf3dd7994cb36954f0670430216a71c7b6505d9`. No existing index entry matches
this test; this is a new observation, not a counted recurrence.

Original command: `mise run test:logged -- --name address-full-tests-after-guard-fix -- mise run test`.
The aggregate waited 825.6 s for its predecessor, then admitted workspace
(five slots), root (one), bridges (two) and protocol (one), beside a five-worker
browser suite. The test exceeded 5,000 ms after 5,015.99 ms. A late fixture
`git push -u origin main` into its temporary local origin also failed.
Desktop totals: 2,007 passed, 16 skipped, one failed, one between-tests error;
2,024 tests across 135 files, 63.52 s. Evidence is the workspace log under
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.IYESto/`.

The unchanged complete owner passed with
`mise run test:logged -- --name dev-fixture-isolated -- bun --cwd=apps/desktop test scripts/dev/fixture.test.ts --parallel=2 --only-failures`
(exit 0, 2.1 s). Passing output was removed; no isolated total is claimed.
The cause is unconfirmed. No fixture implementation, assertion or timeout was
changed, and the isolated pass does not replace the aggregate failure.

## Investigation — 2026-11-10

Not fixed, still open. The seeding under test runs Git synchronously
(`runGit` in `apps/desktop/scripts/dev/fixture.ts` uses `spawnSync`, eight
calls for a fresh repository), so Bun cannot report the timeout until the
current Git call returns; the late `git push` error fits the test body
carrying on after its budget while `afterEach` removed the temporary
directories. A JUnit-timed run of the unchanged owner alone at host load
about 34 took 2.79 s for this case (the slowest case took 3.72 s) against
the five-second default. `mise run test:logged -- --name repro-9912 -- bun scripts/test-under-contention.ts --burners 18 -- bun test --cwd apps/desktop ./scripts/dev/fixture.test.ts --preload ../../tests/setup-node.ts --rerun-each=5`
passed (exit 0, 68.8 s), so the failure was not reproduced. No race was
found; the margin is thin for real Git work, and the owner is not in the
slow tier even though it waits on real Git.

## Resolution (2026-11-15)

- **Root cause:** Bun's five-second default budget. The case does real,
  synchronous Git work (eight `spawnSync` calls with no deadline of their own);
  starved of CPU it simply took longer than five seconds while still making
  progress, and the late `git push` error was the body carrying on after Bun
  had already failed it and `afterEach` had removed its directories.
- **Fix:** none in this file. `tests/default-test-timeout.ts`, loaded by
  `tests/setup-node.ts` (the package preload), sets the default to 60 s as a
  hang watchdog. `fixture.test.ts` and `fixture.ts` set no smaller budget, hook
  timeout or inner deadline.
- **Reproduced:** yes — `mise run test:logged -- --name f9855-contention -- bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/isolated-browser.test.ts ./scripts/dev/fixture.test.ts --rerun-each=3`
  is a non-isolated run, in which the preload's default reaches only the first
  file, so `fixture.test.ts` kept Bun's five seconds. It failed this case and
  `re-seeds the same commit …` in all three repetitions at 5,04x to 5,14x ms,
  with the same late `git … push -u origin main failed` error as recorded.
  The same command with `--isolate` (each file gets the preload's 60 s default,
  as the package's `--parallel` scripts do) is recorded under Stress.
- **Note for runners:** in a non-isolated multi-file `bun test` (no
  `--parallel`/`--isolate`), the preload's `setDefaultTimeout` applies only to
  the first file. Every package script and the aggregate pass `--parallel`, so
  this does not affect them.
- **Stress:** `mise run test:logged -- --name f9855-contention4 -- bun scripts/test-under-contention.ts --core 11 --burners 6 -- bash -c 'for i in 1 2 3; do bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/isolated-browser.test.ts ./scripts/dev/fixture.test.ts --isolate || exit 1; done'`
  passed 3 of 3 (63.8 s). The same loop twice on the default core 15, which
  other workers' burners were also loading, passed 2 of 2 (`f9855-contention5`, 389.6 s). A stress pass is
  weaker evidence than a reproduction for the parts not reproduced.
