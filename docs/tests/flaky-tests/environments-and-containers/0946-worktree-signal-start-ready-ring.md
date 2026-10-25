# Worktree-signal start fixture loses its `ready` ring in the aggregate

- **ID:** 0946
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `orkestrator-worktree-signal > start writes a private config from stdin and launches the watcher`
- **File:** `apps/backend/src/core/container-worktree-signal-install.test.ts:319`
- **Original command:** `mise run test:logged -- --name full-0048 -- mise run test` on `todo-0048-recurring-work-qualification-dbe14f8256cc` (storage read path, recurring-work harness and scripts only), macOS 27.0 arm64, Bun 1.4.4, standard worker leases; host load average 50 to 55.
- **Failure:** after 792.46 ms, `expect(rings(dir)).toEqual(["lost", "ready"])` received only `["lost"]`. The fake watcher (`echo 'Watches established.' >&2; exit 1`) ran under a fake `setsid`, and the `ready` ring was missing when the assertion read the ring file.
- **Isolated rerun:** `mise run test:logged -- --name owners-0048 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/container-worktree-signal-install.test.ts ./src/core/coordinator-service.test.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures`: this case passed (113 passed, 1 failed, the failure being case [0248](0248-move-restart-recovery-submodule-timeout.md); 176.81 s). Evidence: `orkestrator-test-run.fSNcim/owners-0048.log.gz` under the host temporary directory.
- **Aggregate evidence:** `orkestrator-test-run.VrI5KW/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` (enclosing log `orkestrator-test-run.JFzi7O/full-0048.log.gz`) under the host temporary directory. Backend 11433 passed, 89 skipped and 4 failed across 11526 tests in 680 files (872.95 s); web 9760 passed; root/support, bridges and the Codex protocol lockfile passed. Test groups finished in 942.4 s; the run exited 1.
- **Hypothesis:** the script reports `ready` once it sees `Watches established.` on the watcher's stderr; under heavy load the watcher can exit and ring `lost` before the ready check reads that line, an ordering race in the start script or its fixture. Unconfirmed. No worktree-signal code, assertion or skip changed.
