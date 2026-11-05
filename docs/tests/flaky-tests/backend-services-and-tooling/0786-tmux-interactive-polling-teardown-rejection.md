# Interactive tmux polling teardown rejects cleanup

- **ID:** 0786
- **Status:** resolved
- **Date observed:** 2026-10-24
- **Test:** `Electron tmux environment teardown > environment teardown detaches active interactive terminal polling`
- **Owning file:** `apps/backend/tests/tmux-commands-teardown.test.ts`
- **Parents:** feature `2e7edbc161b60cb188437783168f8bc8135f5953` and main `95c9cb46ae0a2b12fbc10ff73fa7c0614b254a0d`.
- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=0014505caeed69395b3cc996dd541fcc6df12c23 mise run test:logged -- --name refresh-0043-suite -- mise run test`.
- **Worker configuration:** default 4/1/2/1 workspace/root/bridge/protocol reservations, two backend Bun workers, alongside browser and Electron checks.
- **Failure:** `claude-tmux cleanup incomplete for environment` from `tmux-commands.ts:189`, reached through the test at line 594 (609.75 ms).
- **Suite counts:** backend: 10,857 passed, 117 skipped and two failed across 650 files (572.16 s). The other failure was the OpenCode research-server deadline, tracked in [0785](../coordinator-and-multi-review/0785-opencode-research-server-registration-timeout.md).
- **Complete unchanged owner:** `mise run test:logged -- --name refresh-0043-tmux-teardown-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/tmux-commands-teardown.test.ts --parallel=1 --only-failures` passed (exit 0, 4.0 s).
- **Evidence:** `orkestrator-test-run.fqu9cJ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** confirms an intermittent cleanup rejection; no narrower root cause has been established. No implementation, assertion, deadline or skip changed. The aggregate result remains failed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** same file and same `claude-tmux cleanup incomplete` rejection as [0236](0236-tmux-teardown-cleanup-rejection.md), and close to [0245](0245-tmux-orphan-hook-restore.md); probably one cause. The throw at `tmux-commands.ts:189` follows a `cleanupComplete = false` path that logs a `[tmux] ... failed during environment cleanup` warning. The owner passed alone today (15/15, 3.9 s; Bun 1.4.4).
- **Next step:** on recurrence, read the warning just before the throw to see which cleanup step failed, and handle 0236, 0245 and 0786 together.


## Migration timeout coverage review recurrence — 2026-10-26

- Command: `mise run test:logged -- --name repository-tests -- mise run test`,
  Linux x64, workspace/root/bridge/protocol reservations 4/1/2/1, two backend
  workers, migration test-only commit `006b1000`.
- The interactive-polling case rejected cleanup as incomplete at 70.08 ms.
- Backend: 11,793 passed, 143 skipped, eight failed in 707 files (547.71 s).
  Full suite evidence and the other failures are recorded in
  [1003](../aggregate-validation-runs/1003-legacy-migration-0058-validation.md#timeout-coverage-review-validation--2026-10-26).
- Complete unchanged owner:
  `mise run test:logged -- --name tmux-teardown-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/tmux-commands-teardown.test.ts --parallel=1 --only-failures`
  passed, exit 0, 1.2 s.
- Artifact: `/tmp/orkestrator-test-run.1QvzPF/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
  Cause remains unconfirmed; no implementation, assertion, timeout or skip changed.


## Root cause and fix — 2026-11-05

- **Cause:** when the fake tmux runtime (`apps/backend/tests/tmux-test-harness.ts`)
  has no sessions, its `list-sessions` prints `no server running`, and
  `confirmTmuxSessionGone` (`apps/backend/src/core/tmux-shared.ts`) then runs a
  real `ps -A -o pid=,comm=` census. Any tmux server on the host made that
  census report a live tmux, so `cleanupEnvironmentTmux` treated teardown as
  incomplete and rejected, leaving the installed hook in place. The case
  passed or failed according to whether a tmux server happened to be running
  on the host at that moment, which is why isolated reruns passed.
- **Demonstration:** on macOS with a dev profile's tmux server running (pid
  60760), `bun test --cwd apps/backend ./tests/tmux-commands-teardown.test.ts
  ./tests/tmux-commands-mcp.test.ts` failed the same five cases every time
  (27 passed, 5 failed). The four `Electron tmux environment teardown` cases
  (0236, 0245, 0786 and `environment teardown kills live sessions, restores
  settings and removes the runtime root`) and `does not hold the tmux install
  lock while first-prompt naming is prepared` all failed. With a `ps` on PATH
  that printed no tmux, those five passed. Only the private-tmux case then
  failed, because it needs the real `ps -p`.
- **Fix:** `a7cce0038` adds a `ps` shim to the fake runtime's PATH. It answers
  only the `-A -o pid=,comm=` census, with no tmux in it, and passes every
  other call to the real `ps`. `tmux-lifecycle-fixture.ts` already scoped its
  census this way.
- **Verification:** with the host tmux server still running, all ten suites
  that import the harness passed together:
  `mise run test:logged -- --name tmux-harness-r4 -- bun test --cwd apps/backend
  <the ten tmux-*.test.ts files> --preload ../../tests/setup-node.ts
  --parallel=4 --only-failures`, exit 0 in 18.0 s.
- **Not proved:** the earlier Linux and aggregate occurrences above were not
  re-run with a census log. They match this cause, but each one was not shown
  to have had a host tmux server running.
