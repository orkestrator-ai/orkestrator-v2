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
