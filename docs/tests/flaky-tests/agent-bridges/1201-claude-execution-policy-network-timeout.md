# Claude execution policy network qualification timeout

- **ID:** 1201
- **Status:** resolved
- **Date observed:** 2026-10-27
- **Test:** `Claude CLI execution policy qualification > network`
- **File:** `bridges/claude-bridge/src/conformance-execution-policy-live.test.ts`

During coordinator worker-surface review-fix validation, `mise run test`
failed the network case at 17,008.89 ms because its abort controller fired.
This fixture uses the pinned CLI and a scripted local model endpoint; no live
model service is involved. The complete unchanged owning file passed alone
(4 tests, 25.2 s):

```sh
mise run test:logged -- --name bridge-policy-owner -- bun test --cwd bridges/claude-bridge ./src/conformance-execution-policy-live.test.ts --parallel=1 --only-failures
```

The aggregate log is `orkestrator-test-run.2JIWtv/bridges.log` in the host
temporary directory. This is a confirmed aggregate-only timing failure.
No timeout, assertion, skip, or bridge implementation was changed.

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
