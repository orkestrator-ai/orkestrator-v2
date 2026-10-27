# Keyboard shortcuts menu branch validation (2026-10-27)

- **ID:** 1130
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `keyboard-shortcuts-8ea8474c65c7-r1` (HEAD `be5fdcf35` before the validation fixes), against `origin/main` `863b57821`.
- **Changed areas:** `apps/desktop/electron` (menu, native input, previews), `apps/web` (shortcuts dialog, design frame bridge), `packages/protocol` (shortcut matcher), `e2e/` and docs. No backend, bridge or root-script source changed.

## Aggregate runs

| Run | Evidence (below `$TMPDIR`) | Result |
| --- | --- | --- |
| Branch, extended `mise run test` (all areas) | `orkestrator-test-run.sVsyQR/` | workspace, root/support and bridges failed after about 26.5 min; Codex protocol lock check passed. 64 distinct failing cases. |
| `origin/main`, all areas, worktree `/tmp/orkestrator-origin-main-full-verify` | `orkestrator-test-run.oJeuRo/` | Same three groups failed after about 27.4 min. 19 distinct failing cases. |
| Branch, standard `mise run test` | not retained | Stopped at the 30-minute wrapper deadline. |

The host had 18 CPUs, and other worktrees ran full suites at the same time (load averages 60–120 during the reruns below).

## Owning-file reruns

Each command was `mise exec -- bun test --preload ../../tests/setup-node.ts <file>` from `apps/backend`, or `mise exec -- bun test <file>` from the repository root or `apps/desktop`. "Main" means the same command in a detached `origin/main` worktree.

| Owning file | Branch alone | Main alone | Disposition |
| --- | --- | --- | --- |
| `apps/backend/src/core/environment-move.test.ts` | 32 passed, 6 failed (five-second deadlines) | 15 passed, 23 failed (load average about 117) | Load-dependent; reproduces on main. |
| `apps/backend/tests/commands-integration.test.ts` | 53 passed, 2 failed (artifact excludes, scan caches) | same two failed | Reproduces on main; see 0162, 0300. |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | 1 passed, 3 failed (five-second deadlines) | 0 passed, 2 failed | Reproduces on main; see 0947, 0957. |
| `apps/backend/tests/worktree-watcher.test.ts` | `observes a real file write` failed | same case failed | Reproduces on main; see 0091. |
| `apps/backend/tests/staged-input-relay.test.ts` | 4 failed | same four failed | Reproduces on main (rootless relay work, todo 0109). |
| `apps/backend/tests/docker-image.test.ts` | 2 `pinned image identity` cases failed | same two failed | Reproduces on main. |
| `tests/unit/migrate-copy.test.ts` | 2 `verified copy helper` cases failed | same two failed | Reproduces on main; already retained in 1013. |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | 2 `pruneProfiles` cases failed (unexpected `keychainWarning` on darwin) | same two failed | Deterministic on macOS since #1299; already retained in 1013. |
| `change-tracking/acceptance-sharing`, `diff-stats-tracking`, `commands-environment-worktree-location`, `commands-environment-fork` | Failed alone at load average about 80; **all passed** unchanged at about 50 | `worktree-location` retargeting failed; others passed | Load-dependent timing failures. |
| `tests/commands-registry-environments.test.ts`, `tests/tmux-commands-teardown.test.ts`, `public-api-project-init-cascade.test.ts`, `tests/backend-core.test.ts`, `tests/unit/test-all.test.ts`, `apps/web/.../MessageRenderBoundary.test.tsx` | All passed | n/a | Aggregate-only timing failures. |
| `bridges/claude-bridge/src/conformance-execution-policy-live.test.ts` (and the coordinator sandbox qualification) | Aggregate: five live-CLI cases aborted at about 17 s | Aggregate: seven cases of the same suites aborted at about 17 s | Reproduces on main; see 0672 and todo 0030. |

No assertion, deadline, skip or implementation in these files changed on the branch. None of them covers the keyboard-shortcuts change. The branch's own web, desktop, protocol and browser shortcut tests pass (see the PR).

## Electron and browser

- The `design-canvas-electron.spec.ts` quit deadline reproduces on main: [1131](../design-canvas-and-artifacts/1131-design-electron-graceful-quit-deadline.md).
- The mobile Monaco startup miss in `e2e/KeyboardShortcuts.spec.ts` (also seen on main) is [0792](../web-ui/0792-keyboard-shortcuts-monaco-startup.md), resolved on this branch with a startup-only budget.

## Review-fix validation — 2026-10-27

Fix commit: `772eba03e` on the same keyboard-shortcuts branch. The follow-up
retains pending native origins across renderer reopens, extracts the production
input/ownership routing for focused tests, and adds accelerator-open-dialog and
outside-pointer scenarios. No backend, bridge or root implementation changed.

Passing checks:

- `mise run format:check`, `mise run lint`, `mise run typecheck` through
  `test:logged` (`shortcuts-final-format`, `shortcuts-lint`, `shortcuts-types`).
- Focused desktop controller/routing tests and the complete
  `KeyboardShortcutsDialog.test.tsx` owner.
- `ORKESTRATOR_E2E_PORT=15427 mise run test:logged -- --name shortcuts-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/KeyboardShortcuts.spec.ts --workers=2`:
  both viewport projects passed, including outside-pointer dismissal and typing.
- `mise run test:logged -- --name shortcut-flake-index -- bun test ./tests/unit/flaky-tests-index.test.ts --parallel=1 --only-failures`.

The complete Electron command was
`mise run test:logged -- --name shortcuts-electron -- mise run test:agent:electron`:
25 passed, 2 failed, 1 skipped, 16 did not run in 277.2 s. The changed
`electron-main`, `workspace-realm`, artifact-host and design-canvas scenarios
passed. Failure evidence is in host temporary directory
`orkestrator-test-run.dHDi6z/shortcuts-electron.log.gz`; structured results and
traces are under `output/agent-testing/electron-smoke/electron/`.

Owning-file Electron reruns used `bunx playwright test --config
e2e/agent-testing/playwright.electron.config.ts <owning-file> --workers=1`
through `test:logged`, with separate run IDs:

| Owner | Result | Evidence below host temporary directory |
| --- | --- | --- |
| `service-preview-electron.spec.ts` | 11 passed, 1 failed, 5 did not run (83.8 s). Same `HMR v2 not applied in place` 30-second predicate failure. | `orkestrator-test-run.HH1rLS/service-preview-owner-rerun.log.gz` |
| `web-annotations-electron.spec.ts` | 11 passed, 1 failed, 1 did not run (103.8 s). The original reload/restart scenario passed, but the DPR/zoom scenario later failed the same `closeElectron` child-count predicate (three children alive after 20 s). The owner did not pass, so this is not recorded as a confirmed flake. | `orkestrator-test-run.oAE1hk/annotations-owner-rerun.log.gz` |

The native realm run recorded `native-focus`: macOS did not activate the test
window, so DOM handoffs ran while physical native-focus assertions could not.
Packaged macOS/Linux qualification remains open in
[0325](../../../todo/cross-cutting/0325-keyboard-shortcuts-desktop-gaps.md).

The full non-iOS aggregate,
`mise run test:logged -- --name shortcuts-unit-suite -- mise run test`, finished
with exit 1 after 688.6 s. Workspace/root/bridge/protocol groups reserved
4/1/2/1 worker slots. Both slow areas ran because of the branch's protocol
package change. Workspace, root/support and bridge groups failed; the Codex
protocol-lock check passed. Web reported 9,952 passed/10 skipped/0 failed;
desktop reported 1,394 passed/16 skipped/2 failed (the existing `pruneProfiles`
cases); backend reported 12,031 passed/120 skipped/21 failed and 12 errors;
root/support reported 3,526 passed/2 failed. Cursor's one readiness failure
passed in the owning-file rerun and is recorded in [0182](../agent-bridges/0182-cursor-auth-readiness-aggregate-timeout.md).

Full evidence is in `orkestrator-test-run.RKStpZ/` (`summary.json` and the four
compressed group logs), with outer output in
`orkestrator-test-run.ryekIw/shortcuts-unit-suite.log.gz`. The failures are in
unchanged backend, profile-cleanup, copy-helper and Cursor code. This follow-up
does not independently re-establish their historical `main` reproduction.

Owning-file Bun reruns used `test:logged`, `--parallel=1 --only-failures`, and
`--preload ../../tests/setup-node.ts` from the owning package (root copy-helper
uses the root configuration):

| Owner | Result | Failure artifact directory below host temporary directory |
| --- | --- | --- |
| `tests/unit/migrate-copy.test.ts` | 10 passed, 2 failed; same extract-status mismatch (1.8 s) | `orkestrator-test-run.Mw4fFX` |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | 20 passed, 2 failed; same macOS `keychainWarning` expectation mismatch (0.9 s) | `orkestrator-test-run.tXqBUq` |
| `apps/backend/src/core/environment-move.test.ts` | 21 passed, 17 failed, 13 errors; Git/submodule timeouts and cascading removed-fixture errors (163.3 s) | `orkestrator-test-run.9T3sUq` |
| `apps/backend/tests/commands-registry-environments.test.ts` | 66 passed, 2 failed, 1 error; Git/worktree test and following cleanup hook deadlines (41.6 s) | `orkestrator-test-run.NMDyaH` |
| `apps/backend/tests/commands-integration.test.ts` | 54 passed, 1 failed, 1 error; artifact-exclude status-read timeout and removed fixture (29.0 s) | `orkestrator-test-run.1z6jE2` |
| `apps/backend/tests/docker-image.test.ts` | 19 passed, 2 failed; same host-address argument expectations (1.8 s) | `orkestrator-test-run.VVqtsA` |
| `apps/backend/tests/worktree-watcher.test.ts` | 33 passed, 1 failed; no observed write event (2.8 s) | `orkestrator-test-run.zPRFqi` |
| `apps/backend/tests/staged-input-relay.test.ts` | 5 passed, 4 failed; same permissions, cleanup and relay-content expectations (0.6 s) | `orkestrator-test-run.F7JNfv` |

These owning files still failed, so no new flake claim, assertion relaxation,
skip or unrelated implementation fix was made for them.
