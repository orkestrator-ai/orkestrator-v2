# Terminal registry worker killed during agent upgrade validation (`tests/unit/electron/commands-registry-terminal.test.ts`)

- **ID:** 0143
- **Status:** open
- **Date observed:** 2026-09-08, Bun 1.4.0, Linux x64, agent-upgrade worker
  based on `0c2a07e962ea1f609e9692dd7d54e5cc9b92da54`.
- **Original command:** `bun run test:logged -- --name full-upgrade-suite -- bun run test`.
  The four standard groups ran concurrently (root: four workers; bridges: two;
  workspace: one worker per package, two package tasks). `bun run check` also
  ran concurrently in this observation.
- **Failure:** `tests/unit/electron/commands-registry-terminal.test.ts (worker crashed: SIGKILL)`.
  No assertion or per-case duration was reported. The root group finished in
  123.36 s with 4,002 passed, two skipped and three failures across 189 files.
  The other two failures were independently reproduced deterministic issues:
  Pi's removed experimental import and two unbounded DOM absence assertions;
  both were corrected in this upgrade.
- **Evidence:** `/tmp/orkestrator-test-run.SU58b5/root-and-agent-support-tests.log.gz`.
- **Isolated rerun:** `bun run test:logged -- --name terminal-registry-isolated -- bun test tests/unit/electron/commands-registry-terminal.test.ts`
  passed in 17.2 s without source changes to this owner.
- **Hypothesis:** external process termination under concurrent validation
  load. SIGKILL alone does not identify the sender or establish an OOM; no
  specific cause or fix is claimed. This is distinct from the older resolved
  malformed-framing assertion timeout in the same file. The final aggregate
  retry ran without a concurrent repository typecheck and passed all four
  groups in 341.2 s. The root group passed 4,073 tests, skipped three and
  failed zero in 102.1 s; no terminal worker crash recurred. This passing
  observation does not establish the cause or close the worker-kill incident.
