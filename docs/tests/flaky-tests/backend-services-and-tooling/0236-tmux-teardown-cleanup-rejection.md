# Tmux teardown cleanup rejects under aggregate load

- **ID:** 0236
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Test:** `Electron tmux environment teardown > a start queued behind environment teardown rejects the deletion tombstone`
- **File:** `apps/backend/tests/tmux-commands-teardown.test.ts:458`
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU-tool PATH.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; the backend package used two isolated Bun workers. Component browser validation also ran.
- **Failure:** `await expect(cleanup).resolves.toBeUndefined()` at line 503 received a rejected promise instead of a resolved promise (234.65 ms). The captured assertion did not identify the rejection reason.
- **Suite counts:** backend reported 7,890 passed, 39 skipped and one failed across 433 files (319.44 seconds). Workspace finished with 12 successful tasks out of 13. The root group separately hit the known Pi runtime timeout (0178); bridges and protocol passed.
- **Isolated rerun:** `mise run test:logged -- --name merge-tmux-teardown-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/tmux-commands-teardown.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 2.2 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.j0YfiD/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** aggregate load may expose ordering or process-cleanup timing in the fake tmux runtime; the isolated pass establishes intermittency, not its cause. The owning test and implementation were unchanged by this merge. No assertion, timeout or skip was changed.
- **2026-10-22, deterministic on one host:** on macOS with Homebrew tmux 3.7c, `mise run test:logged -- --name tmux-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/tmux-commands-teardown.test.ts ./tests/tmux-commands-mcp.test.ts --parallel=1 --only-failures` failed the same five cases every time (27 passed, 5 failed): the four `Electron tmux environment teardown` cases above plus `Electron tmux MCP config and session start > does not hold the tmux install lock while first-prompt naming is prepared`, with `cleanupEnvironmentTmux` rejecting. The log shows `uninstallWorkspaceHooks failed during environment cleanup Error: EISDIR: illegal operation on a directory, open '<tmp>/ork-tmux-runtime-*/worktree/.claude/settings.local.json'`. The same five failed in a clean worktree of `main` at `b83ae534`, so they predate the 0039 MCP branch that observed them. While this holds it is not a flake on this host; it needs a fix.


## Migration timeout coverage review recurrence — 2026-10-26

- Command: `mise run test:logged -- --name repository-tests -- mise run test`,
  Linux x64, workspace/root/bridge/protocol reservations 4/1/2/1, two backend
  workers, migration test-only commit `006b1000`.
- The deletion-tombstone case rejected cleanup at 85.49 ms.
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
