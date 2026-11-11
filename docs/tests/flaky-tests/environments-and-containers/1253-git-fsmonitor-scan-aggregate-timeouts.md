# Git fsmonitor scans exceed the aggregate test deadline

- **ID:** 1253
- **Status:** open
- **Date observed:** 2026-10-28
- **File:** `apps/backend/src/core/git-fsmonitor.test.ts`
- **Original command:** `mise run test` during review preparation at `05737aff0133f4d7a377ec30d1cfb37f514b71de`.
- **Worker configuration:** default concurrent workspace/root/bridges/protocol groups, with 6/1/2/1 reserved worker slots respectively.

Four `git fsmonitor` cases exceeded the 5,000 ms test deadline:

| Test | Reported duration |
| --- | --- |
| `a linked project-home scan preserves the user's setting and daemon` | 5,011.98 ms |
| `a scan retries migration after a transient rev-parse failure` | 5,006.85 ms |
| `a scan retries migration after a transient --get failure` | 5,007.89 ms |
| `a scan retries migration after a transient --unset failure` | 5,010.35 ms |

The backend reported 10,117 pass, 87 skip, 4 fail and 4 between-test errors
across 664 files (100.98 s). The errors included Git status/diff commands
terminated with SIGTERM after the test deadline. The other three aggregate
groups passed; the aggregate exited 1 after 155.6 s.

Preparation evidence is in `validation-05.stdout.txt` under
`.orkestrator/review-artifacts/review-validation-8de2a0fc-89bc-48db-8014-285a48ced97e/`.

The complete unchanged owner passed alone (exit 0, 8.3 s) with:

```sh
mise run test:logged -- --name git-fsmonitor-isolated -- bun test --cwd apps/backend ./src/core/git-fsmonitor.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

The aggregate-only recurrence is consistent with timing contention around real
Git processes, but the cause has not been established. No fsmonitor code,
assertions, timeouts or skips changed.

The exact original command then passed through the logging wrapper:

```sh
mise run test:logged -- --name default-tests-rerun -- mise run test
```

The wrapper exited 0 after 147.3 s. Keep the case open: a passing rerun does
not establish that the aggregate timing issue is fixed.

## Coordinator upstream-send review recurrence — 2026-10-28

Review preparation at `3f6fc3016ae881312ba3afde8145832603d59719` repeated
five-second timeouts in the linked project-home scan and the transient
`rev-parse` and `--get` migration scans. The aggregate exited 1 after 373.0 s;
its root, bridge and protocol-lockfile groups passed. Preparation evidence is
`.orkestrator/review-artifacts/review-validation-41f403c0-5bc8-4df1-8983-e2fdbef55ac5/validation-04.stdout.txt`.

The complete unchanged fsmonitor owner passed alone in 10.1 s (exit 0):

```sh
mise run test:logged -- --name git-fsmonitor-isolated -- bun test --cwd apps/backend ./src/core/git-fsmonitor.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

It also passed alongside the native-agent admission and image-download owners
with one Bun worker (99 tests, 14.5 s). No fsmonitor implementation, assertion,
clock or skip changed in this repair.

The exact aggregate rerun (`mise run test` through `test:logged`) passed the
fsmonitor cases and retained only the unrelated activity-batch timeout tracked
in [0247](../native-agents-and-transcripts/0247-activity-batch-sweep-no-requests.md).


## Queued-prompt keyboard review recurrence — 2026-10-28

Preparation at `91513d96d` repeated all four named five-second timeouts:
linked project-home scan (5,033.16 ms), transient `rev-parse` (5,013.48 ms),
`--get` (5,029.51 ms) and `--unset` (5,010.94 ms). `mise run test` used default
workspace/root/bridge/protocol reservations of 6/1/2/1 (backend four workers)
alongside the nine-worker browser suite. Backend reported 10,153 passed,
87 skipped and six failed, including the two source-store cases in 0932;
the aggregate failed its workspace group after 332.2 s. Evidence:
`.orkestrator/review-artifacts/review-validation-23a7a6f9-6912-45a3-b66d-327817cf8f1d/validation-04.stdout.txt`.

The complete unchanged fsmonitor and source-store owners passed sequentially
with one Bun worker (exit 0, 9.8 s):

```sh
mise run test:logged -- --name recorded-backend-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/git-fsmonitor.test.ts ./src/core/mcp-management/source-store.test.ts --parallel=1 --only-failures
```

No fsmonitor implementation, assertion, timeout or skip changed. The passing
logged runner discarded detailed output; contention remains an unproven cause.

The exact original aggregate command then passed (exit 0, 274.7 s):

```sh
mise run test:logged -- --name review-repair-tests -- mise run test
```

The successful rerun does not establish a flake fix; this case remains open.

## Merge-readiness review preparation — 2026-10-28

Preparation for `mergeable-pr-environment-shimmer-09258728cf65` repeated the
transient `--get` and `--unset` migration scan timeouts (5,010.70 ms and
5,020.74 ms). Evidence is `validation-04.stdout.txt` in
`.orkestrator/review-artifacts/review-validation-2b5424e9-f105-4cc7-afcd-918fa109916c/`.
The complete unchanged owner passed alone (exit 0, 12.6 s):

```sh
mise run test:logged -- --name git-fsmonitor-owner -- bun test --cwd apps/backend ./src/core/git-fsmonitor.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

No fsmonitor implementation, tests, assertions or deadlines changed.

## Uniform app shortcuts review recurrence — 2026-10-28

Preparation at `c73f44755` repeated the four five-second scan deadlines
(linked project-home 5,012.92 ms; transient rev-parse 5,038.27 ms; --get
5,008.28 ms; --unset 5,024.25 ms), during `mise run test` with the default
workspace/root/bridges/protocol worker reservations of 6/1/2/1 alongside
component-browser validation. The complete unchanged owner passed alone:

```sh
mise run test:logged -- --name fsmonitor-owner -- bun test --cwd apps/backend ./src/core/git-fsmonitor.test.ts --parallel=1 --only-failures
```

Exit 0, 8.9 seconds. Preparation evidence:
`.orkestrator/review-artifacts/review-validation-b78694d3-cfea-4eae-8896-38cb77ce8e81/validation-04.stdout.txt`.
No implementation, assertion, timeout or skip changed; this remains an open
aggregate timing case.


After fixing an unsupported build option in the newly added minification
regression, the exact original repository command was rerun:
`mise run test:logged -- --name review-repair-tests -- mise run test`.
All four groups passed (exit 0, 204.1 seconds). The fsmonitor assertions and
timeouts remain unchanged.

## Remote project-search review recurrence — 2026-10-28

Preparation at `8ac47666e` repeated the linked project-home scan (5,028.33 ms),
transient `--get` (5,039.73 ms), and transient `--unset` (5,012.08 ms) deadlines.
The default `mise run test` ran alongside component browser validation and
failed its workspace group after 394.1 seconds; root, bridge, and protocol
checks passed. Backend reported 10,163 passed, 87 skipped, three failed and
three between-test errors. Evidence is `validation-04.stdout.txt` under
`.orkestrator/review-artifacts/review-validation-567e75fe-4f47-4151-9031-8f6c94a373ce/`.

The complete unchanged owner passed alone (exit 0, 7.1 seconds):

```sh
mise run test:logged -- --name fsmonitor-owner -- bun test --cwd apps/backend ./src/core/git-fsmonitor.test.ts --parallel=1 --only-failures
```

No fsmonitor implementation, assertion, deadline, or skip changed. Contention
remains a hypothesis; this is an open recurrence, not an established fix.

The exact recorded aggregate command then passed all four groups (exit 0,
369.4 seconds):

```sh
mise run test:logged -- --name review-repair-tests -- mise run test
```

The passing aggregate does not establish a timing fix; this case remains open.


## Live logging round 2 repair — 2026-11-02

`mise run test:logged -- --name fix-default -- mise run test` failed
`git fsmonitor > a scan retries migration after a transient --unset failure`
after 5,012.89 ms, with a SIGTERM `git diff --name-status` rejection between
tests. Workspace used five worker slots (backend two), root one, bridges two,
and protocol one. Backend totals were 13,069 pass, two fail, with the other
failure in standalone-ready timing. The complete unchanged fsmonitor owner
passed alone (23 tests, exit 0, 8.3 s):

`mise run test:logged -- --name branch-fsmonitor-owner -- bun test --cwd apps/backend ./src/core/git-fsmonitor.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`

Detached `origin/main` at `88c3c6bac`, using independently installed dependencies,
also passed the complete owner (7.8 s). An attempted `--rerun-each=10` run
reported nine failures in the preload-inheritance assertion after its first
iteration (221 pass, nine fail); these are different failures and do not
reproduce the aggregate scan timeout. Main has not reproduced that timeout,
so this sighting is not an environmental excuse. No fsmonitor implementation,
assertion, timeout or skip changed.

Evidence: `output/agent-testing/review-fix-53284689/default-workspace.log.gz`.


The final exact aggregate rerun (`fix-default-final`, 562.0 s) passed this
owner unchanged. Its only failure was the independently reproduced design
profile ledger race in case 1314. This passing rerun does not establish a
timing fix for the earlier observation.


## Backend logger review repair — 2026-11-02

The unintended four-worker broad backend invocation recorded in
[1250](../aggregate-validation-runs/1250-structured-tickets-validation.md#backend-logger-review-repair--2026-11-02)
reported `git fsmonitor > a scan retries migration after a transient rev-parse
failure` at 5,019.36 ms, with an in-flight Git diff rejected after SIGTERM.
That run was stopped after 146.3 s (exit 130), so complete-suite counts are
unavailable. Evidence: host temporary artifact directory
`orkestrator-test-run.Lba259`, `review-fix-backend.log.gz`.

The unchanged complete owner was rerun alone:

```sh
mise run test:logged -- --name fsmonitor-isolated -- bun test --cwd apps/backend ./src/core/git-fsmonitor.test.ts --parallel=1 --only-failures
```

It still failed: 22 pass, one fail, one between-test error, 12.5 s. This time
`a scan retries migration after a transient --unset failure` hit 5,017.10 ms;
Git diff `--numstat` was interrupted with SIGTERM. Evidence: host temporary
artifact directory `orkestrator-test-run.N8qXT0`, `fsmonitor-isolated.log.gz`.
This observation has no isolated passing result and is an outstanding
validation limitation, not a newly established flake or an environmental
excuse. No fsmonitor implementation, assertion, timeout or skip changed.


## Backend logger main merge — 2026-11-02

`mise run test:logged -- --name merge-default-tests-recheck -- mise run test`
while merging `d7054dace` into `8f174e4db` repeated
`git fsmonitor > a scan retries migration after a transient rev-parse failure`
(5005.18 ms, 5000 ms budget). Default scheduler reservations for
workspace/root/bridges/protocol were 5/1/2/1. The aggregate exited 1 in
282.9 s; the workspace also retained four shifted-link failures and one
desktop keepalive failure.

The complete unchanged owner passed alone, exit 0 in 3.5 s:
`mise run test:logged -- --name merge-rerun-git-fsmonitor -- bun test --cwd apps/backend ./src/core/git-fsmonitor.test.ts --parallel=1 --only-failures`.
No Git implementation, assertion, timeout, or skip changed. Evidence:
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.LvO7CJ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## R4 diagnostics final validation — 2026-11-03

`mise run test:logged -- --name r4-final-default-suite -- mise run test` timed
out `git fsmonitor > a scan retries migration after a transient --unset failure`
at 5029.46 ms. Backend totals: 13,378 passed, 99 skipped, two failed and one
error; the other failure was preview-upstream-pool. The root, bridges and
protocol groups passed. The owner and implementation have no diff in
`origin/main...HEAD`.

The complete unchanged branch owner passed alone (exit 0, 3.6 s):
`mise run test:logged -- --name r4-git-fsmonitor-owner -- bun test --cwd apps/backend ./src/core/git-fsmonitor.test.ts --parallel=1 --only-failures`.

A detached main worktree at `62e99ff599cfcfa2bfdd23f907b8f05039925d63`, with
independently installed frozen dependencies, reproduced the exact --unset scan
timeout at 5006.19 ms:
`mise run test:logged -- --name r4-main-git-fsmonitor-preloaded -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/git-fsmonitor.test.ts --parallel=1 --rerun-each=10 --only-failures`.
It reported 218 passed, 12 failed and three errors across 230 cases. Ten failures
were the fixture's fsmonitor-off prerequisite; the remaining failures included
--get and --unset scan timeouts. An earlier 20-repeat main run reported 438
passed, 22 failed and three errors, including --get timeouts. These are observed
baseline failures, not a root-cause diagnosis or a production fix.

Evidence:
- Branch: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.OdacnP/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Main (10 repeats): `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.7G8PDc/r4-main-git-fsmonitor-preloaded.log.gz`.
- Main (20 repeats): `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.P19uWS/r4-main-git-fsmonitor-owner.log.gz`.

No assertion, timeout, skip, or unrelated implementation changed.

## E19 terminal WebSocket review preparation — 2026-11-04

Review preparation at `b211f60f6` ran `mise run test` with
workspace/root/bridges/protocol reservations of 6/1/2/1 and timed out a case
not named above: `git fsmonitor > project-home status auto-starts and preserves
the configured daemon` at 5,010.51 ms against its 5,000 ms budget. Bun printed
`killed 1 dangling process` directly before the failure. Backend totals were
15,016 pass, 113 skip, two fail and one error across 1,012 files (247.63 s). The
other failure was the coordinator-mail fallback, triaged unrelated. The root,
bridges and protocol groups passed.

The one error was `# Unhandled error between tests`, a `CommandFailedError` for
`git status --porcelain=v2 --branch --untracked-files=normal` with signal
`SIGTERM` and `timedOut: false`, thrown through
`retryGitWithoutFsmonitorOnTimeout` from `readStatus` in
`project-git-service.ts`, the path this test exercises. It fits the between-test
errors recorded above: a Git child outlives the test deadline, is signalled and
rejects late. The log does not name the process Bun killed, so that link is
inferred from the matching call path and signal.

The complete unchanged owner passed alone at `71bd88528` (exit 0, 18.0 s):
`mise run test:logged -- --name fsmonitor-owner -- bun test --cwd apps/backend ./src/core/git-fsmonitor.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`.

The branch does not change the owner or `git-fsmonitor.ts`. The cause of the
slow scan is still not established, so this stays open. Evidence:
`.orkestrator/review-artifacts/review-validation-d2e06c1d-324f-4187-a3a6-4afd8fae5ffd/validation-04.stdout.txt`
and `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.sNlZvR/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

No assertion, timeout, skip, or unrelated implementation changed.

### Resolution — 2026-11-06

- **Root cause:** the generic five-second budget was too small for real Git
  and fsmonitor daemon work on a loaded macOS host. The affected cases build
  a repository with a linked worktree and scan it with real Git, and the
  project-home cases also start or stop a real `git fsmonitor--daemon`. On
  macOS the owner took 8.3–18.0 s alone across the recurrences (about 0.3–0.6
  s a case). The fsmonitor commit `cddc3e004` measured about 1.1 s added to
  each fsmonitor-enabled Git call there. Each command already carries its own
  10–30 s deadline, but Bun's generic five-second test deadline cut the case
  off first ("killed 1 dangling process"). The killed `git status` then
  rejected through `retryGitWithoutFsmonitorOnTimeout` after the test ended,
  which is the recorded "Unhandled error between tests" with SIGTERM and
  `timedOut: false`. On Linux, where no daemon starts, the slowest case takes
  0.15 s.
- **Fix:** `apps/backend/src/core/git-fsmonitor.test.ts` sets a 30 s file
  budget with `setDefaultTimeout`, matching its own per-command Git
  deadlines. No assertion changed.
- **Reproduction:** the unchanged file with `--timeout 60` reproduced both
  recorded signatures: nine "this test timed out" with "killed 1 dangling
  process", and seven "# Unhandled error between tests". The five-second
  deadline itself was not reached on Linux.
- **Verification:** six runs of `mise run test:logged -- --name
  env-fsmonitor-runN -- bun --cwd=apps/backend test
  ./src/core/git-fsmonitor.test.ts ./src/core/commands-files-local-scan.test.ts
  --parallel=2`: all PASS. `--rerun-each` cannot stress this owner: on the
  second and later iterations `fixture repositories inherit fsmonitor off from
  the test preload` fails, and it fails identically on the unchanged file
  (`--rerun-each=2`: 49 pass, 1 fail). It is a rerun artifact of preload
  state, not this flake.

## Launch-override marker review repair recurrence — 2026-11-11

Reopened: `mise run flaky:recurrence 1253 --base 498b68766f5c9f357a3a86782406d1e9e0977559`
reported the base contains the 2026-11-06 fix (`cddc3e004`), so this is a real
recurrence.

- **Branch / base:** `launch-override-marker-043a84998c41-r1` at `3fadd7c66`,
  merge base `498b68766f5c9f357a3a86782406d1e9e0977559`. The branch does not
  change the owner, `git-fsmonitor.ts` or `ProjectGitService`.
- **Command:** `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test:logged -- --name
  review-default-tests-rerun -- mise run test` (default concurrent groups; the
  guard stage was skipped because it fails on an unrelated finding already on
  the base, and was run separately).
- **Failure:** `git fsmonitor > project-home status auto-starts and preserves
  the configured daemon` failed at 11,422.97 ms, not at a deadline: after
  `ProjectGitService.status` returned, `git fsmonitor--daemon status` rejected
  where the test expected it to resolve containing "is watching"
  (`git-fsmonitor.test.ts:281`). So the daemon was not (yet) watching when
  status returned on a loaded host. That is a different signature from the
  earlier deadline timeouts and the 30 s file budget does not cover it.
- **Suite counts:** backend 18,325 pass, 200 skip, 1 fail across 1,276 files
  (339.66 s); every other group passed.
- **Isolated rerun:** the runner's own one-file rerun of
  `apps/backend/src/core/git-fsmonitor.test.ts` passed (25 pass, 0 fail, 4.6 s).
- **Hypothesis (unconfirmed):** the daemon auto-start is asynchronous, and under
  load `git fsmonitor--daemon status` can run before the daemon reports
  watching. Not investigated further in this change.

## Flaky-test fixes review preparation recurrence — 2026-11-11

`mise run flaky:recurrence 1253 --base acc3d6834cafd02e76729958b25078c7337253b0`
reported `open`: record it as a recurrence.

- **Branch / base:** `fix-flaky-tests-400972eda2c6-r1` at `e758b359b`, merge
  base `acc3d6834cafd02e76729958b25078c7337253b0`. The branch changes web
  transcript code, e2e specs, CLI and backend tests, and one backend test
  helper (`agent-mail-world-test-support.ts`, imported only by tests). It does
  not change the owner, `git-fsmonitor.ts`, `ProjectGitService` or any module
  the owner imports.
- **Command:** `mise run test:logged -- --name review-default-tests -- mise run
  test` (review preparation; default concurrent groups).
- **Failure:** the same signature as the launch-override recurrence above:
  `git fsmonitor > project-home status auto-starts and preserves the
  configured daemon` failed at 11,313.37 ms because `git fsmonitor--daemon
  status` rejected at `git-fsmonitor.test.ts:281` after `status` returned.
- **Suite counts:** backend 18,016 pass, 200 skip, 1 fail across 1,272 files
  (173.57 s).
- **Isolated rerun:** the runner's one-file rerun of
  `apps/backend/src/core/git-fsmonitor.test.ts` passed alone (3.5 s).

