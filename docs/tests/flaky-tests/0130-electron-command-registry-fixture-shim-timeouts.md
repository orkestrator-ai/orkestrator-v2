# Electron command-registry fixture-shim timeouts (four tests, three files)

- **ID:** 0130
- **Status:** resolved
- **Date observed:** 2026-08-17
- **Tests:**
  - `Electron backend command registry > rolls back a local rename when push configuration fails` (`tests/unit/electron/commands-registry-environments.test.ts:1667`, assertion at `:1672`)
  - `Electron backend command registry > advances the stored branch when a local rollback fails and the new branch is the only one left` (`tests/unit/electron/commands-registry-environments.test.ts:1709`, assertion at `:1717`)
  - `Electron backend command registry > rejects malformed container status framing and invalid encoded sections` (`tests/unit/electron/commands-registry-terminal.test.ts:1408`, assertion at `:1418`)
  - `Electron backend command registry > treats empty, null, and non-boolean draft output as non-draft` (`tests/unit/electron/commands-registry-pr.test.ts:634`, assertion at `:650`)
- **Original command:** `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`, at `19a1001123b16a89e2a09324a0033ae9b26eb74f` on `agent-jsonl-acp`.
- **Worker configuration:** The root group ran on its own with `--parallel=4`, not under `scripts/test-all.ts`. No other suite was running against this clone.
- **Failure:** all four are Bun's generic `this test timed out after 5000ms`, at 5,004.99 ms, 5,004.18 ms, 5,002.52 ms and 5,017.16 ms respectively. Each is accompanied by an "Unhandled error between tests" block showing its fixture shim was already gone when the command finally ran:
  - the two environments cases logged `[ElectronBackend] Failed to rename local git branch: CommandFailedError: Command failed: git -C /var/folders/.../ork-electron-rename-repo-<suffix> branch -m -- old-branch review-oauth-flow`, then a post-timeout `git ... branch --show-current` against a temp repo directory that had already been torn down;
  - the terminal case reported `expect(received).toThrow(expected)`, expected substring `"Malformed"`, received `"Command failed: docker exec container-1 bash -lc ..."` (the full `get_git_status` script), i.e. the fake `docker` shim was no longer on `PATH`;
  - the PR case reported `Expected promise that resolves / Received promise that rejected` at `commands-registry-pr.test.ts:650`, inside `withFakeGh` (`tests/unit/electron/command-fixtures.ts:1212`).
- **Suite counts:** 3,724 passed, 1 skipped, 4 failed, 4 errors, 16,581 `expect()` calls; 3,729 tests across 178 files in 361.24 seconds. The four errors are the four "Unhandled error between tests" blocks above. The bridges group and the web, backend, desktop and acp-bridge typechecks all passed in the same validation round.
- **Isolated rerun:** each owning file passed alone — `bun run test:logged -- --name rerun-env-alone -- bun test tests/unit/electron/commands-registry-environments.test.ts` -> exit 0 in 34.4 s; `... commands-registry-terminal.test.ts` -> exit 0 in 28.7 s; `... commands-registry-pr.test.ts` -> exit 0 in 34.8 s.
- **Follow-up:** the identical whole-group command passed on a rerun later the same day, exit 0 in 161.9 s — under half the failing run's 361.24 s. The wall-clock gap is the useful part of that observation: the failing run was roughly 2.2x slower overall, which is consistent with host contention rather than with anything specific to these four cases.
- **Related:** the "Command-registry Git fixture, deduplicated/admitted container starts, and process-launch coverage" row of the 2026-08-16 resolution sweep. That sweep raised the shared condition deadline to 10 s and gave several cases explicit budgets precisely because the shared helper's deadline had grown past Bun's 5 s default. These four cases wait on real `git`/`docker`/`gh` shims but carry **no** `ASYNC_TEST_BUDGET_MS`, so Bun's 5 s default still wins and reports a generic timeout instead of naming the condition.
- **Hypothesis:** Same family as that sweep row rather than a new product defect — the change in flight touched only `bridges/acp-bridge`, which none of these files load. Under `--parallel=4` the real `git`/`docker`/`gh` shim processes under `$TMPDIR` are slow enough to exceed the 5 s outer budget; the timeout then interrupts the case mid-flight and its `finally` tears the shim down, which is what produces the trailing "command failed"/"promise rejected" errors *after* the timeout rather than before it. The log also shows repeated "killed 1 dangling process" lines around them. A recurrence should record how long the shim command actually took before any budget is raised: give each of the four an explicit `ASYNC_TEST_BUDGET_MS` so the named condition wins the race and the real latency is visible, rather than widening a tolerance against a generic timeout.
- **Recurrence (2026-08-27):** `verifies a PR against the trusted project and
  environment branches` timed out at 5,021.86 ms in the four-worker root suite
  and then passed with its owner in isolation. It uses the same real `gh` shim
  and teardown boundary, so it now carries `ASYNC_TEST_BUDGET_MS` without
  changing its repository, canonical-URL, head-branch, or base-branch checks.
- **Recurrence (terminal case only), 2026-08-17:** `rejects malformed container
  status framing and invalid encoded sections` failed alone under
  `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`
  at `55539f08ac3dcb3b4b9e18e522f881e9992f9057` on `unify-agent-components`, four
  Bun workers on the root suite alone, with the bridges and web suites run back
  to back in the same session. Same two symptoms as above in the same order —
  `expect(received).toThrow(expected)` at `:1418`, expected substring
  `"Malformed"`, received `Command failed: docker exec container-1 bash -lc …`
  (the git-status script echoed back), then a 5,019.09 ms timeout and one
  trailing "Unhandled error between tests" for the same case. Suite counts:
  `3727 pass, 1 skip, 1 fail, 1 error. Ran 3729 tests across 178 files. [379.1s]`
  — again roughly 2.2x the passing run's wall clock. Isolated rerun
  `bun run test:logged -- --name root-terminal-isolated -- bun test tests/unit/electron/commands-registry-terminal.test.ts`
  → exit 0 in 31.7 s, and the same aggregate command passed at the follow-up
  commit in the same session (79.6 s, exit 0). The change in flight touched only
  the chat transcript, agent cards and background tasks, none of which this path
  loads. One alternative worth ruling out when the measurement above is taken:
  the received message is the *unrejected* command failure rather than the
  framing error, which would also fit the queued `docker` stub answering a
  different invocation than the one under test — an ordering dependency between
  queued fakes rather than plain shim latency. The isolated file takes 31.7 s in
  total with no single case near 5 s, so recording which stubbed command actually
  answered distinguishes the two before any budget is raised.
- **Recurrence and resolution (2026-09-19):** `mise run test` reported five more
  five-second fixture-shim timeouts: `reports a queued container PR as pending
  when the captured PR remains open` (5,002.71 ms) plus four branch-rename cases
  in `commands-registry-environments-create.test.ts` (5,001.29–5,002.76 ms).
  Their owning files passed alone in 22.1 s and 30.9 s respectively. The tests
  now use the shared 30-second `ASYNC_TEST_BUDGET_MS`, so their real shim work
  can finish and any shared wait helper can report its named failure instead of
  Bun terminating the test at five seconds. A combined focused rerun of the
  changed root files passed in 58.2 s, then `mise run test` passed all four
  groups under the full eight-worker host budget in 142.3 s. A subsequent
  `mise run test:all` also passed those groups and the iOS group.
