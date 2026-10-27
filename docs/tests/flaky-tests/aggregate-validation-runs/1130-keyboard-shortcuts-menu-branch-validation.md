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
