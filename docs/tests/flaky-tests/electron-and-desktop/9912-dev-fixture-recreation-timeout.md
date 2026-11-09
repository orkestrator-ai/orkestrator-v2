# Development fixture recreation timeout

- **ID:** 9912
- **Status:** open
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
