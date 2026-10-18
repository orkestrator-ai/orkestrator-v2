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
