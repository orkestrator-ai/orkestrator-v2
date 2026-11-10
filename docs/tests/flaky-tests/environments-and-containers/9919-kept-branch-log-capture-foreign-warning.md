# Kept-branch notice test caught a warning from outside its cleanup step

- **ID:** 9919
- **Status:** resolved
- **Date observed:** 2026-11-10
- **Test:** `environment cleanup steps > logs a kept branch once, though a step can run again`
- **File:** `apps/backend/src/core/environment-cleanup.test.ts:353`

## Observation (2026-11-10)

- **Run:** GitHub Actions CI, job `Tests (backend)` (job 129551301823, run
  42731774001) for PR #2034, branch `linux-agent-tools-29544f492910-r1`,
  head `d530ab31b`, through `mise run test:full` (the backend group's
  `test:workspace` script, `--parallel=2`).
- **Failure:** after 827.54 ms,
  `expect(logs.outputs.map((output) => output.method)).toEqual(["info"])`
  received `["info", "warn"]`. The warning's text is not in the job log:
  `captureLogs()` diverts it into the test's array.
- **Other runs:** the same test passed in the ten other `Tests (backend)` runs
  of PRs #2028–#2037 inspected on 2026-11-10, and passed alone on this host
  (`bun test --preload ../../tests/setup-node.ts src/core/environment-cleanup.test.ts`,
  39 pass). On a heavily loaded macOS host other cases of the same file hit
  the 5 s per-test timeout; that is load, not this case.

## Resolution (2026-11-10)

- **Cause (hypothesis, not reproduced):** `captureLogs()` replaces the
  process-wide logger sink, so it records every entry the test worker writes
  while the test runs, including work left over from earlier tests in the
  file. Both cleanup-step calls returned `true`, so the step itself did not
  log `cleanup.step-failed`; the warning came from somewhere else.
- **Fix:** the assertion now considers only records whose `scope` or
  `environmentId` is this test's environment, so a warning from the step
  itself (`cleanup.step-failed`, `cleanup.record-failed`, both carrying
  `environmentId`) still fails it, while a foreign one does not.
- **Supporting observation:** on a macOS host at load average about 66, this
  test timed out at 5 s inside its own `git` setup, and the next test in the
  file (`513 kept-branch notices do not consume shared fault keys`) then
  captured 514 records instead of 513: work left running by a timed-out test
  logs into whichever test holds the capture next.
- **Reproduced:** not the CI warning itself; its source could not be
  recovered from the CI log.

## Review follow-up (2026-11-10)

- Scoped the adjacent `513 kept-branch notices do not consume shared fault
  keys` assertion to its 513 environment IDs too. Both `scope` and
  `environmentId` count, so a warning belonging to one of those cleanups still
  fails the assertion.
- The test now deliberately emits a foreign `cleanup.step-failed` warning
  into the shared capture and verifies that it is captured while all 513 own
  records remain branch-kept notices. This provides a deterministic regression
  for the cross-capture mechanism without relying on a timed-out predecessor.
- Focused validation: `mise run test:logged -- --name findings-backend -- bun
  test --cwd apps/backend --preload ../../tests/setup-node.ts
  ./tests/github-ranges-cache.test.ts ./src/core/environment-cleanup.test.ts
  --parallel=1 --only-failures` passed (5.4 s).
