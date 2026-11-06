# Printing a non-zero runCommand failure times out in the aggregate

- **ID:** 4044
- **Status:** open
- **Date observed:** 2026-11-04
- **Test:** `failures runCommand produces > a non-zero exit prints without its stdout or stderr`
- **File:** `apps/backend/src/core/command-failed-error-print.test.ts`
- **Original command:** `mise run test:logged -- --name full-test -- mise run test`
  on branch `sub-agent-models-ed8b12224ab5-r1`, which does not change `runCommand`
  or this test.
- **Worker configuration:** the default `mise run test` groups, on a host at load
  average 83–96 with other work running.
- **Failure:** hit the 5 s test timeout at 5002.04 ms. Backend workspace group:
  14046 pass, 1 fail (workspace group 1027.8 s). Artifact:
  `orkestrator-test-run.z5S1lI`.
- **Isolated rerun:** `bun --cwd=apps/backend test
  src/core/command-failed-error-print.test.ts --parallel=1` passed the unchanged
  file twice, about 0.6 s each.

## Current assessment

The case spawns a real child process, and the failure was a timeout rather than a
wrong result, so host load is the likely cause. It did not fail in the previous
aggregate run on the same branch. No reproduction yet.

## Investigation — 2026-11-06

Status stays open; no fix. The test spawns one real `sh -c 'echo …; exit 3'` through `runCommand` and then formats the error in memory. There is no sleep, fixed wait, port or shared state to correct. The only observation is a 5 s timeout at host load average 83–96, which is spawn latency on a saturated host and matches the default-tier rule that real processes belong in the slow tier when they are not deterministic. Options for the owner: leave it as is, or move the real-spawn cases of `command-failed-error-print.test.ts` to the slow tier. Neither was done here.
