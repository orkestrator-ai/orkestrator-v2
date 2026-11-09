# Container fake Claude install: interrupted install timed out on CI

- **ID:** 9906
- **Status:** open
- **Date observed:** 2026-11-09
- **Test:** `interrupted install followed by another install keeps the first backup`
- **File:** `e2e/agent-testing/container-fake-claude-install.test.ts:78`

## Observation (2026-11-09)

- **Run:** CI `main` run 42548177778 (`20c6129a2`, #1993), job "Tests (root-bridges)" 128937628237, the "root and
  agent-support tests" group of `bun scripts/test-all.ts` (Ubuntu 26.04, four
  cores). The group ran for 295.6 s and this was its only failure; the
  bridges group passed.
- **Failure:** `error: fixture shell failed` thrown by the fixture's `asNode`
  (`container-fake-claude-install.test.ts:46`) from the installer's `undo`
  (`container-fake-claude-install.ts:25`), called at test line 83, followed by
  `this test timed out after 5000ms` (5,761.25 ms).
- **Isolated rerun:** `bun test e2e/agent-testing/container-fake-claude-install.test.ts`
  passed 5 of 5 on macOS arm64 on 2026-11-09 (6 pass each, about 0.33 s for
  the file). Observed from branch `fix-ci-main-5daa3930bd92`, base
  `448e9fffb`. Not rerun on Linux.
- **Hypothesis (unproven):** the case runs five synchronous `spawnSync("sh")`
  calls (the `cat`, `cp` and `jq` snippets, then `undo`) under Bun's default
  5 s test timeout, and each spawn has its own 5 s `timeout`. A non-zero
  status from `undo`'s spawn after more than 5 s fits a spawn killed by that
  timeout (status `null`) while the runner was saturated by the group's other
  files. No failure output says which status the spawn returned. The fixture
  throws the same message for every non-zero status, so the next recurrence
  cannot say either unless the message gains `result.status`,
  `result.signal` and `result.error?.code`.
- **Next step:** at the next recurrence, add the spawn's status, signal and
  error code to the fixture's error before changing any budget. No timeout,
  assertion or retry was changed.
