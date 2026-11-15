# Seeded workflow records review: mixed-owner aggregate failures

- **ID:** 9999
- **Status:** open
- **Date observed:** 2026-11-13
- **Snapshot:** `f4be0d1d1` on `workflow-store-testing-551c328ddecd-r1` (base `17d28238c`), the Multi Review validation for the `dev:test --seed-workflow-records` change.
- **Original command:**
  `mise run test:logged -- --name review-default-tests -- mise run test`
  (default worker plan). Exit 1 after 1,076 s of test groups. The runner's own
  rerun of the first failing owner queued behind another worktree's exclusive
  resource (16 of 16 host slots reserved), spent its 600 s budget without a
  verdict, and left the other two owners not rerun.
- **Groups:** guards, bridges and the codex protocol lockfile passed. The
  workspace group (backend 18,301 tests, 1 fail; web 14,732 tests, 1 fail) and
  the root and agent-support group (1 fail) failed.

## Failures and complete owning-file reruns

| Test | Failure | Owner rerun alone (2026-11-13, same branch) |
| --- | --- | --- |
| `agent mail store size benchmark > rejects malformed, empty, missing and nonpositive sizes` in `apps/backend/tests/agent-mail-store-size-bench.test.ts` | `this test timed out after 5000ms` (5,002 ms) | `mise run test:logged -- --name rerun-store-size-bench -- bun --cwd=apps/backend test tests/agent-mail-store-size-bench.test.ts --parallel=1 --only-failures` passed, exit 0, 9.9 s. |
| `a remote workspace opens Docker in parent Settings and every action targets its selected host` in `apps/web/src/components/settings/SettingsPage.test.tsx` | Failed after 1,277 ms in the web workspace run | `mise run test:logged -- --name rerun-settings-page-3 -- bash -c 'cd apps/web && NODE_ENV=test bun --no-env-file ../../scripts/bun-test-tier.ts apps/web src/components/settings/SettingsPage.test.tsx -- --only-failures --parallel=1'` passed, exit 0, 6.3 s. (Run without `--no-env-file` from a shell with `NODE_ENV=production`, every case fails on `React.act is not a function`; that is the invocation, not this flake.) |
| `counting link > a reset drops what is queued for the connection and counts it as dropped` in `e2e/agent-testing/remote-bandwidth-meter.test.ts` | `expect(after.droppedBytes).toBeGreaterThan(0)` received 0 at `:397` (1,190 ms) | `mise run test:logged -- --name rerun-bandwidth-meter -- bun test ./e2e/agent-testing/remote-bandwidth-meter.test.ts --parallel=1 --only-failures` passed, exit 0, 1.1 s. |

The branch changes only development scripts (`apps/backend/scripts/`,
`apps/desktop/scripts/dev/`), their tests and documentation. None of the three
owners imports a changed file. The review package's failure triage left the
bandwidth-meter case `undetermined` (`dependency-graph-incomplete`) and listed
no other owner because the command did not finish. Host contention is a
hypothesis consistent with the 5 s timeout and the queued rerun, not a
confirmed cause. No assertion, timeout or skip was changed.

## Recurrence 2026-11-14 (base dc90609bf)

The silent-failure-notices review (`mise run test:logged -- --name
review-default-tests -- mise run test`, default worker plan, 1,137 s of test
groups) failed the store-size bench's
`rejects malformed, empty, missing and nonpositive sizes` on its 5 s deadline
with an empty child stderr, while 16 of 16 host slots were reserved. The
runner's own rerun alone also timed out (21.4 s file, same queue). The owner
then passed alone on the same branch:
`mise run test:logged -- --name bench-alone -- bun --cwd=apps/backend test ./tests/agent-mail-store-size-bench.test.ts --parallel=1`,
exit 0, 3.7 s. The branch changes the writer lease, the OpenCode provider and
agent-testing helpers; the bench imports none of them.
`mise run flaky:recurrence -- 9999 --base dc90609bf` answered open.


## Recurrence — 2026-11-15 (messages history recovery review repairs)

`ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test` on `messages-history-recovery-8fd703ff5288-r1` at `97a468e06`, base `a8b89f1541e7abb6af36d45121593ae14640a3ca` (Linux x86_64, beelink2, host load average about 40 on 16 cores from other worktrees' suites; 385.9 s of test groups), failed the store-size bench's
`rejects malformed, empty, missing and nonpositive sizes` and
`rejects exhaustion including the warm-up sample before measuring`, each on
its 5 s deadline, with an empty child stderr reported between tests (backend:
18,471 pass, 2 fail). The runner's own rerun of the file alone passed (4.0 s,
"likely a load flake"). The branch changes transcript paging (the native
projection, the OpenCode snapshot, the HTTP bridge reader) and docs; the
bench imports none of them. `mise run flaky:recurrence -- 9999 --base
a8b89f1541e7abb6af36d45121593ae14640a3ca` answered open. No assertion,
timeout or skip changed.

## Recurrence 2026-11-15 (base a8b89f154)

The project-removal review fix (`ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run
test`, default worker plan, host slots shared with other worktrees) timed out
the bench's `rejects malformed, empty, missing and nonpositive sizes` at its
5 s deadline. The aggregate runner's lone rerun of the unchanged file:
`PASSED ALONE (9.9s)`. The branch changes Kanban, project and pipeline
storage; the bench imports none of those modules. `mise run flaky:recurrence
-- 9999 --base a8b89f154` answered open.
A second run on the same branch (commit e4f8a20d3, before the rebase onto main) timed out the same case
again, and this time the runner's rerun inside the busy aggregate also timed
out (11.0 s file). The owner then passed alone:
`mise run test:logged -- --name bench-alone -- bun --cwd=apps/backend test ./tests/agent-mail-store-size-bench.test.ts --parallel=1`,
exit 0, 10.0 s.


## Main-merge validation — 2026-11-15 (macOS)

On `apply-root-changes-157033210ba5-r1`, base
`33ade4a3c9741237ba0619bb2b6220e76df14184`, the command
`mise run test:logged -- --name merge-tests -- mise run test` completed every
default test group in 1,253.7 s and failed. The logged wrapper exited 1 after
1,343.2 s. Backend used three isolated workers, web two, root one, and bridges
two host slots. Guards and the Codex protocol check passed. Results:

| Group/package | Passed | Skipped | Failed | Errors |
| --- | --- | --- | --- | --- |
| Backend | 18,416 | 203 | 44 | 32 |
| Web | 14,916 | 10 | 3 | 0 |
| Root and agent support | 4,891 | 29 | 13 | 2 |
| Cursor bridge | 930 | 1 | 1 | 1 |

Other workspace packages and bridges passed. The suite started with merge
commit `99d78626f`; another worker committed `e57bfc447` in the shared tree
during this work, so these results do not qualify that newer commit or the
subsequent main merge.

The benchmark's two cases named in the previous recurrence timed out at
5,003.36 ms and 5,002.50 ms. Its complete unchanged owner was rerun with:

`mise run test:logged -- --name merge-store-bench-owner -- bun test --cwd apps/backend ./tests/agent-mail-store-size-bench.test.ts --parallel=1 --only-failures`

It also failed (18.3 s; one pass, two failures, two errors), both on their
5 s limits with empty child stderr. This observation does not independently
establish intermittence. `mise run flaky:recurrence -- 9999 --base
33ade4a3c9741237ba0619bb2b6220e76df14184 --registry-ref origin/main` returned
`open`.

An additional mixed-owner failure in this run was
`AgentNativeTab > capability-driven parity > passes the complete composer control set when resuming`
in `apps/web/src/components/native-agent/AgentNativeTab.parity.test.tsx`:
`Earlier work` was absent at the assertion after 116.32 ms. The complete
unchanged owner passed separately (exit 0, 40.2 s):

`mise run test:logged -- --name merge-parity-owner -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.parity.test.tsx --parallel=1 --only-failures`

Passing output was deleted by the logged runner; owner totals are not inferred.
This establishes intermittence, not a cause or a fix. Separate complete owners
for `diff-baseline.test.ts` (six pass, one fail, one error, 16.9 s) and
`TerminalContainer.notes.test.tsx` (zero pass, one fail, 5.9 s) remained
non-green; other failures remain unclassified. No assertion, timeout or skip
was changed.

The aggregate's automatic reruns queued behind another worktree's new suite.
After every original group had finished, only this run's queued retry phase
was cancelled with SIGINT; it reported no verdict for those automatic reruns.
The original failures remain failures. No development profile was started.

Evidence (private host temporary storage):

- Aggregate group logs: `orkestrator-test-run.96Ybtn/`.
- Outer failure log: `orkestrator-test-run.8d4AhR/merge-tests.log.gz`.
- Benchmark owner: `orkestrator-test-run.sZSgRJ/`.
- Git baseline owner: `orkestrator-test-run.uk6Q4D/`.
- Notes owner: `orkestrator-test-run.YBBVa1/`.

All directories above are under
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/`.
