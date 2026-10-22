# Terminal registry worker killed during agent upgrade validation (`apps/backend/tests/commands-registry-terminal.test.ts`)

- **ID:** 0143
- **Status:** open
- **Date observed:** 2026-09-08, Bun 1.4.0, Linux x64, agent-upgrade worker
  based on `0c2a07e962ea1f609e9692dd7d54e5cc9b92da54`.
- **Original command:** `bun run test:logged -- --name full-upgrade-suite -- bun run test`.
  The four standard groups ran concurrently (root: four workers; bridges: two;
  workspace: one worker per package, two package tasks). `bun run check` also
  ran concurrently in this observation.
- **Failure:** `apps/backend/tests/commands-registry-terminal.test.ts (worker crashed: SIGKILL)`.
  No assertion or per-case duration was reported. The root group finished in
  123.36 s with 4,002 passed, two skipped and three failures across 189 files.
  The other two failures were independently reproduced deterministic issues:
  Pi's removed experimental import and two unbounded DOM absence assertions;
  both were corrected in this upgrade.
- **Evidence:** `/tmp/orkestrator-test-run.SU58b5/root-and-agent-support-tests.log.gz`.
- **Isolated rerun:** `bun run test:logged -- --name terminal-registry-isolated -- bun test apps/backend/tests/commands-registry-terminal.test.ts`
  passed in 17.2 s without source changes to this owner.
- **Hypothesis:** external process termination under concurrent validation
  load. SIGKILL alone does not identify the sender or establish an OOM; no
  specific cause or fix is claimed. This is distinct from the older resolved
  malformed-framing assertion timeout in the same file. The final aggregate
  retry ran without a concurrent repository typecheck and passed all four
  groups in 341.2 s. The root group passed 4,073 tests, skipped three and
  failed zero in 102.1 s; no terminal worker crash recurred. This passing
  observation does not establish the cause or close the worker-kill incident.

## Recurrence — 2026-09-19

- **Original command:** `mise run test:changed` with the standard four affected
  groups and four root workers.
- **Failure:** `Electron backend command registry > reports a target ref the
  container cannot resolve` exceeded its 5,000 ms test budget. Its expected
  target-ref diagnostic was replaced by the generic fake-Docker command
  failure after the fixture process was killed. The root group reported 2,371
  passed, two skipped, 13 failed and 10 unhandled errors across 82 files in
  188.2 s; several sibling fake-Docker tests failed in the same run.
- **Isolated rerun:** `mise run test:logged -- --name isolate-terminal-registry
  -- bun test ./apps/backend/tests/commands-registry-terminal.test.ts
  --parallel=1 --only-failures` passed all tests in 26.6 s without source
  changes to this owner.
- **Hypothesis:** this recurrence strengthens the existing concurrent-load
  hypothesis: the owner passes alone, while the aggregate run killed its
  fixture and then timed out at the outer test deadline. It does not identify
  which process terminated the fixture.

## Move-fix validation recurrence — 2026-10-12

- **Original command:** `mise run test:logged -- --name move-full-suite -- mise run test` with the testing guide GNU-tool PATH; standard 2/3/2/1 group slots. The isolated browser suite ran concurrently.
- **Failure:** `includes untracked container files only when working-tree changes are requested` timed out after 5002.43 ms; the worker did not crash in this recurrence.
- **Suite counts:** Root/support group: 4,997 passed, 24 skipped, 18 failed and 6 errors across 253 files; backend: 5,860 passed, 15 skipped, 2 failed. The compatibility writer regression and move fixture index contention were corrected separately.
- **Isolated rerun:** `mise run test:logged -- --name move-terminal-isolated -- bun test ./apps/backend/tests/commands-registry-terminal.test.ts --parallel=1 --only-failures` passed, exit 0, in 39.5 seconds.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.DTErJR/` (compressed group logs).
- **Hypothesis:** subprocess deadlines under concurrent host load remain plausible; the isolated pass does not establish a root cause. No timeout, assertion or skip was changed.
