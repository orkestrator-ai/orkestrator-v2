# Standalone backend readiness SIGKILL escalation fails under aggregate load

- **ID:** 0491
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `waitForStandaloneBackendReady > escalates SIGTERM to SIGKILL after the grace period`
- **File:** `apps/backend/tests/standalone-ready.test.ts`
- **Original command:** `mise run test:logged -- --name full-test-2 -- mise run test`
  on branch `qualify-coordinator-live-six-platforms-fb2b4a53344d` (live
  coordinator qualification; this branch does not change the standalone
  backend or its readiness wait).
- **Worker configuration:** the default `mise run test` groups, workspace
  group concurrent with the root, bridges and codex-protocol groups, on a host
  at load average 36–69 with live suites running in other environments.
- **Failure:** the case failed at 176.00 ms in the backend workspace group.
  Workspace artifact:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.qqP6B1/`.
- **Isolated rerun:** `bun test tests/standalone-ready.test.ts` from
  `apps/backend` passed the unchanged file (6 pass, 0 fail).

## Current assessment

The case times a grace period against a real child process. Under heavy host
load the signal and exit ordering it observes can shift. Keep open until a
recurrence on a normally loaded host gives the assertion message.

## Todo 0732 main merge — 2026-10-28

`mise run test:logged -- --name merge-default-tests -- mise run test`
merged `d3842173e` into `f521032b1`. Default workspace/root/bridges/protocol
workers were 6/1/2/1; host admission queued the groups for about 389 s.
The backend reported 9,967 pass, 87 skip and two failures across 656 files
(322.08 s). Root, bridges, protocol and the other workspace packages passed;
the aggregate remained non-green (927.4 s including admission).
Evidence: `orkestrator-test-run.LxnFHE/summary.json` and
`workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
under the host temporary directory; outer logged-run artifacts are in
`orkestrator-test-run.cjGI8A`.

The grace-period case failed at 209.89 ms: line 90 expected only `SIGTERM`
but had already received `SIGKILL` too. The complete unchanged owner passed
with
`mise run test:logged -- --name merge-standalone-ready-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/standalone-ready.test.ts --parallel=1 --only-failures`
(exit 0, 0.7 s). This is consistent with the real-timer ordering race;
no readiness implementation, assertion, timeout or skip changed.

## Coordinator PR-tab review — 2026-10-28

Preparation's `mise run test` against `5800c3a3e` observed the same line-90
assertion at 163.47 ms: expected `["SIGTERM"]`, received `["SIGTERM",
"SIGKILL"]`. The unchanged readiness owner passed alone with
`mise run test:logged -- --name readiness-owner -- bun test --cwd apps/backend ./tests/standalone-ready.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
(exit 0, 0.8 s). The owner also passed 100 repetitions on detached
`origin/main` (`cc869af0c`) with independently installed dependencies.

The PR-tab branch changes neither readiness implementation nor tests. The
original diagnostic is in `validation-04.stdout.txt` under
`.orkestrator/review-artifacts/review-validation-7fbfbe48-2f07-4bb1-be42-3d89516efbed/`;
focused rerun outputs are in `.orkestrator/fix-validation/readiness-owner.log`
and `baseline-readiness.log`. Keep the case open; isolated success does not
establish that aggregate timing is fixed.

The exact original command, `mise run test`, then passed on the fixed PR-tab
branch (exit 0; 589.3 s including host admission). Its output is in
`.orkestrator/fix-validation/default-suite-rerun.log`. No readiness code or
assertions changed. A full detached `origin/main` run had a separate OpenCode
agent-tool timing failure, with no readiness failure.

## Project landing-tab review — 2026-10-28

Preparation's `mise run test` repeated the early SIGKILL assertion at line 90
(94.28 ms), using the default concurrent workspace/root/bridges/protocol groups.
The unchanged complete owner passed alone (exit 0, 1.0 s):

```sh
mise run test:logged -- --name prior-standalone-failure -- bun --cwd=apps/backend test ./tests/standalone-ready.test.ts --parallel=1 --only-failures
```

Preparation evidence is `validation-05.stdout.txt` in
`.orkestrator/review-artifacts/review-validation-715de670-9258-47de-9a56-3b5d32afcae9/`.
No readiness code, assertions, timeouts or skips changed.

## Git fsmonitor removal validation — 2026-10-28

`mise run test` on branch `git-fsmonitor-leak-and-hangs-969095f24ee2` (backend
git fsmonitor handling; nothing in the standalone backend or its readiness
wait) on macOS at load average 40–60 failed this case at 141.95 ms: line 90
had already seen `SIGKILL`. The unchanged owner, run alone with
`bun test tests/standalone-ready.test.ts` from `apps/backend`, failed once in
four runs while the load average was about 60, then passed 8 of 8 as it fell
to about 40. A clean `dfedcd743` (origin/main) clone passed 14 of 14 over the
same window. Consistent with the real-timer ordering race recorded above, now
also seen in isolation on a heavily loaded host. Evidence:
`orkestrator-test-run.2rpgar/` under the host temporary directory. No
implementation, assertion, timeout or skip changed.

## Capacity retry review — 2026-10-30

Preparation's `mise run test` failed when the first signal assertion already included SIGKILL (94.27 ms).
The backend reported 2 failures in the default aggregate with its normal
concurrent groups. Evidence is `validation-05.stdout.txt` under
`.orkestrator/review-artifacts/review-validation-197e8c94-de90-4cb9-9a1d-f52dd1d193c4/`.

Both unchanged owners passed together with one isolated worker (exit 0, 3.3 s):

```sh
mise run test:logged -- --name preparation-backend-failures -- bun test --cwd apps/backend ./src/core/commands-agent-tools.test.ts ./tests/standalone-ready.test.ts --parallel=1 --only-failures
```

Consistent with the previously recorded real-timer scheduling sensitivity;
no product code, assertions, timeouts, or skips in these owners changed.

The exact default-suite command subsequently passed (exit 0, 160.5 s):
`mise run test:logged -- --name capacity-review-default-tests -- mise run test`.


## Hidden flow graph review — 2026-10-31

The required exact `mise run test` rerun repeated this assertion after 86.20 ms.
The first signal assertion already included `SIGKILL` alongside `SIGTERM` at line 90.
The web package passed all 10,876 tests; the backend had two failures,
including the other timing case recorded in this review.

Both complete unchanged owners then passed with one file worker
(exit 0, 2.4 s):

```sh
mise run test:logged -- --name recorded-backend-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/standalone-ready.test.ts ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures
```

Aggregate evidence: `orkestrator-test-run.Od2gTp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the host temporary directory. No implementation, assertion, timeout or
skip in either owner changed. This repeats the existing intermittent symptom;
no new cause was established.

## Main merge recurrence — 2026-10-31

- **Original command:** `mise run test:logged -- --name merge-default-tests-final -- mise run test`.
- **Workers:** workspace reserved six slots, four isolated backend workers; root one slot and bridges two. Shared Linux host; 120.5 s queued, 432.4 s overall.
- **Failure:** `waitForStandaloneBackendReady > escalates SIGTERM to SIGKILL after the grace period`, `apps/backend/tests/standalone-ready.test.ts:90`, at 74.71 ms. The first signal assertion received both `SIGTERM` and `SIGKILL`, rather than only `SIGTERM`.
- **Counts:** backend 12,374 passed, 107 skipped, two failed across 837 files (159.29 s). The other failure was the tracked node-coordination held-mail assertion (1324). All other workspace packages and the other three aggregate groups passed.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-standalone-ready-owner -- bun test --cwd apps/backend ./tests/standalone-ready.test.ts --parallel=1 --only-failures` passed (exit zero, 0.5 s). Passing raw output was removed by the logger.
- **Evidence:** `/tmp/orkestrator-test-run.jslhMa/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `/tmp/orkestrator-test-run.ks5Kqd/`.

This repeats the early escalation assertion already tracked here. Host scheduling
pressure remains a hypothesis; no implementation, assertion, timeout or skip
changed. The isolated pass does not make the aggregate green.
