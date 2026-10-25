# Coordinator dirty-submodule discarding switch times out in the aggregate

- **ID:** 0945
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `project coordinator > a dirty submodule needs enhanced confirmation before a discarding switch`
- **File:** `apps/backend/src/core/coordinator-service.test.ts`
- **Original command:** `mise run test:logged -- --name full-0048 -- mise run test` on `todo-0048-recurring-work-qualification-dbe14f8256cc` (storage read path, recurring-work harness and scripts only), macOS 27.0 arm64, Bun 1.4.4, standard worker leases; host load average 50 to 55.
- **Failure:** the case exceeded Bun's five-second deadline (5128.46 ms).
- **Isolated rerun:** `mise run test:logged -- --name owners-0048 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/container-worktree-signal-install.test.ts ./src/core/coordinator-service.test.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures`: this case passed; the three files gave 113 passed, 1 failed (case [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md)) and one between-test error (176.81 s). Evidence: `orkestrator-test-run.fSNcim/owners-0048.log.gz` under the host temporary directory.
- **Aggregate evidence:** `orkestrator-test-run.VrI5KW/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` (enclosing log `orkestrator-test-run.JFzi7O/full-0048.log.gz`) under the host temporary directory. Backend 11433 passed, 89 skipped and 4 failed across 11526 tests in 680 files (872.95 s); web 9760 passed; root/support, bridges and the Codex protocol lockfile passed. Test groups finished in 942.4 s; the run exited 1.
- **Related:** resolved cases [0461](0461-coordinator-fetch-remotes-submodule-timeout.md), [0480](0480-coordinator-fetch-remotes-submodule-timeout.md) and [0490](0490-coordinator-fetch-remotes-aggregate-timeout.md) covered the earlier, combined fetch-and-submodule case in the same file.
- **Hypothesis:** the case builds a real repository with a dirty submodule and runs several Git commands; at load average 50 they exceed five seconds. Unconfirmed. No coordinator code, assertion, deadline or skip changed.
