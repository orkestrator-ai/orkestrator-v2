# CLI provider-homes XDG case exceeds the five-second deadline under load

- **ID:** 9994
- **Status:** open
- **Date observed:** 2026-11-11
- **Observing base:** `14df965440e658e09a7b3ce03530bc1781ac2b01` (`main`).
- **Observed head:** `e4777ac3a` on branch
  `terminal-event-reproduction-58a6a9a0fc85-r1`. The branch changes only
  documentation, two agent-testing Electron specs, the headless Electron spec
  list and its unit test; it touches nothing under `packages/cli/` or anything
  that file imports.
- **Test:** `preserves XDG-based Git, gh and mise configuration for backend children`
- **Owning file:** `packages/cli/tests/scenario-provider-homes.test.ts`
- **Original command:**
  `env -u NODE_ENV mise run test:logged -- --name review-default-tests-rerun2 -- mise run test`
  on beelink2 (Linux x86_64, 16 cores, Bun 1.4.4). The browser suite ran
  alongside it, and the host load average was 35 to 67 from other worktrees'
  suites.
- **Failure:** `this test timed out after 5000ms` at 5027.76 ms, followed by
  `killed 1 dangling process`.
- **Aggregate:** the workspace group failed; CLI 516 pass, 1 fail; backend
  18,552 pass and 21 fail (all in the files of
  [9978](../coordinator-and-multi-review/9978-coordinator-wakes-and-git-mirror-timeouts-under-load.md));
  web 14,569 pass and 10 fail (all in the file of
  [9932](../native-agents-and-transcripts/9932-virtuoso-cancellation-fake-clock-timer-count.md)).
  The root, bridge, guard and lockfile groups passed.
- **Owning-file rerun:** the runner's own rerun reported `FAILED ALONE (5.7s)`
  while the host was still loaded. A later
  `env -u NODE_ENV mise run test:logged -- --name cli-provider-homes-alone -- bash -c 'cd packages/cli && bun test tests/scenario-provider-homes.test.ts'`
  passed (1.1 s) at a load average of about 35 and falling.
- **Evidence:** `orkestrator-test-run.avJa6A/review-default-tests-rerun2.log.gz`
  under the host temporary directory.

The test spawns backend children and waits on them inside Bun's five-second
default, which leaves little margin on a host loaded to several times its
core count. Same shape as [9944](9944-cli-bash-completion-aggregate-timeout.md)
(process per check, five-second deadline). Host load is the likely cause, not
a confirmed diagnosis; reproduce it first, for example with
`scripts/test-under-contention.ts`. No test, timeout, assertion or skip
changed.
