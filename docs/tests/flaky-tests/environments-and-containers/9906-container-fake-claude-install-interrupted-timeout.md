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

## Worktree-watcher review recurrence — 2026-11-10

Observed in `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=7200000 mise run test:logged -- --name coverage-full-final -- mise run test` at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`, base `08d3da4a23cfe2ecc34fba663ca27e765f7924a9`, macOS arm64/Bun 1.4.4. The workspace reserved six slots (web two, backend four), root one, bridges two and protocol one. The aggregate exited 1 after 2468.77 s; backend has no final counts because the workspace no-progress watchdog fired. Root reported 4274 pass/25 skip/4 fail; web 14336 pass/10 skip/2 fail; Pi 706 pass/1 skip/2 fail.

- `e2e/agent-testing/container-fake-claude-install.test.ts` — `interrupted install followed by another install keeps the first backup`: Test deadline 5,000 ms exceeded. Observed 5035.05ms. Complete unchanged owner: 6 pass, 0 fail, 0 skip in 3.65 s at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.

```sh
mise run test:logged -- --name watcher-triage-fake-claude-install -- bun test ./e2e/agent-testing/container-fake-claude-install.test.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/fake-claude-install.xml
```

`mise run flaky:recurrence -- 9906 --base 08d3da4a23cfe2ecc34fba663ca27e765f7924a9 --registry-ref origin/main` reported the case open; this records a recurrence.

Evidence: `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.dH765N/` (compressed group logs); JUnit under `/private/tmp/ork-watcher-failure-triage.0oarZv/`. [The complete report](../../../development/worktree-watcher-validation.md) contains the exact group outcomes, commands and non-green isolated owners. Passing alone establishes intermittence, not a cause or a fix. No related assertion, timeout, skip or implementation changed.
