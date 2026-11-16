# Claude: live CLI qualification runs abort at their deadline under load

- **ID:** 1165
- **Status:** resolved
- **Date observed:** 2026-10-27
- **Tests:** every case of `Claude coordinator sandbox qualification` (`default-sandbox-writes`,
  `coordinator-sandbox-refuses`, `coordinator-sandbox-reads`, `coordinator-hook-refuses`,
  `unavailable-hook-reads`, `unavailable-hook-refuses-quoted`, `unavailable-hook-refuses-escaped`,
  `unavailable-hook-refuses-glob`, `unavailable-hook-refuses-abbreviation`) and of
  `Claude CLI execution policy qualification` (`control`, `escape`, `network`, `unavailable`).
- **Files:** `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts`,
  `bridges/claude-bridge/src/conformance-execution-policy-live.test.ts` (fixtures in
  `bridges/claude-bridge/test-fixtures/coordinator-sandbox-qualification.ts` and
  `tests/conformance/execution-policy/vendor-cli.ts`).
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` on branch
  `todo-0006-session-titles-and-history-dd982dac8857` (macOS, shared host running several other
  branches' suites; the test runner reported 18/18 worker slots reserved for most of the run).
  Bridges group with two worker slots.
- **Failure:** each case failed after 16.3–17.0 s with `Claude Code process aborted by user`
  (`errorClass: "aborted"`) from the Agent SDK, raised by the fixture's own deadline
  (`coordinator-sandbox-qualification.ts:166`), followed by `expect(received).toBeUndefined()`.
- **Suite counts:** claude-bridge 1688 pass, 6 skip, 13 fail (all thirteen above); codex, cursor, pi and acp bridges
  0 fail.
- **Isolated rerun:** `bun test ./src/conformance-coordinator-sandbox-live.test.ts
  ./src/conformance-execution-policy-live.test.ts --preload ../../tests/setup-node.ts --parallel=1`
  from `bridges/claude-bridge`: 13 pass, 0 fail.
- **Hypothesis:** each case starts a real Claude CLI; on a saturated host its start-up alone can
  exceed the fixture's per-case deadline. The branch did not change either test, its fixtures, or
  the Claude CLI launch path (it removed the bridge's unused title subprocess and pruned unused
  imports in `session-manager-core.ts`).

## Resolution (2026-11-15)

- **Root cause:** the qualification runs timed the CLI, not its behaviour. A
  real Claude CLI starts and runs a scripted turn, and each case aborted it
  at a fixed wall-clock deadline: 15 s per turn in
  `test-fixtures/coordinator-sandbox-qualification.ts` (20 s test budget),
  and 15 s of execution after the first model request in
  `conformance-execution-policy-live.test.ts`. The fixture's helper and
  `curl` waits had 5 s and 2 s budgets too. On a starved host a CLI that is
  still making progress runs past those deadlines, and the abort shows up as
  `Claude Code process aborted by user` or `controller.signal.aborted`.
- **Fix:** each deadline is now an idle hang watchdog that a stream message
  re-arms, so only a CLI that has gone silent is aborted. Coordinator
  fixture: a 90 s turn watchdog and 30 s fixture watchdogs (`git`, the helper
  control run, `curl --max-time`). The test budget is
  `QUALIFICATION_TEST_BUDGET_MS` (150 s). Execution-policy test: 120 s
  startup and 90 s execution idle watchdogs, a test budget of their sum plus
  60 s, and `curl --max-time 30`. Every assertion is unchanged, including
  the `controller.signal.aborted` check with its phase diagnostic.
- **Reproduced:** yes. On the unchanged code, under
  `bun scripts/test-under-contention.ts --burners 6` (core 15) with a host
  load average of about 82 from other workers:
  - The execution-policy file with `--rerun-each=2` failed `network` at its
    execution deadline (`elapsedMs=55657 … firstModelMs=38632`).
  - The coordinator-sandbox file failed every listed scenario at about 17 s
    on `signal.aborted`.

  The unchanged copies ran as temporary files beside the originals and were
  deleted afterwards. With the fix, under the same command:
  - Execution policy: 8 of 8 passed in 587.6 s. The same run on core 7
    passed 8 of 8 in 45.4 s.
  - Coordinator sandbox: 19 pass, 0 fail in 641.6 s.
- **Stress:** besides the reproduction runs above, one fixed coordinator
  pass and two fixed execution-policy passes under contention, all green.
  These are live CLI qualifications that take minutes each under load, so
  no `--rerun-each=20`.
