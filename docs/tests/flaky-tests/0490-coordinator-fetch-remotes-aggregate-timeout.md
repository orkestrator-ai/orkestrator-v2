# Coordinator fetch-remotes confirmation timeout under aggregate load

- **ID:** 0490
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `project coordinator > fetch covers every configured remote and a dirty submodule needs enhanced confirmation`
- **File:** `apps/backend/src/core/coordinator-service.test.ts`
- **Original command:** `mise run test:logged -- --name full-test -- mise run test` on branch `qualify-coordinator-live-six-platforms-fb2b4a53344d`
  (live coordinator qualification; this branch does not change
  `coordinator-service.ts`).
- **Worker configuration:** the default `mise run test` groups, workspace
  group concurrent with the root, bridges and codex-protocol groups, on a host
  with a load average between 36 and 69 (several other environments were
  running live suites).
- **Failure:** the test failed at 5237.64 ms, bun's five-second default
  timeout, beside 0165 (5260.49 ms) in the same file and run. Workspace
  artifact:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.UQLOD6/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `bun test src/core/coordinator-service.test.ts` from
  `apps/backend` failed the same two cases once more while the load average
  was 69, then passed the whole unchanged file (52 pass, 0 fail, 19.6 s).

## Current assessment

A timeout under heavy host load, the same shape as 0165: several real Git
fetches against fixture remotes inside one five-second budget. Keep open until
a recurrence on a normally loaded host shows whether it needs an explicit
timeout or cheaper fixtures.
