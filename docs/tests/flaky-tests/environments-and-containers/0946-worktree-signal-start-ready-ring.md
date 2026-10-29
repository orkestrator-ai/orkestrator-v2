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

## Pi fallback review validation — 2026-10-26

- **Original command:** `mise run test` on `todo-0062-pi-chatgpt-login-99fef1be88ca`, Bun 1.4.4, workspace/root/bridges/protocol reservations 4/1/2/1.
- **Failure:** the same test received `["lost"]` instead of `["lost", "ready"]` at line 319 after 1987.70 ms.
- **Suite counts:** backend 11727 passed, 135 skipped, one failed across 11863 tests in 703 files (731.00 s). The workspace group completed in 774.6 s. The bridge and protocol groups passed; root/support also failed on two firewall timeouts and existing case 0887's missing register metadata.
- **Isolated rerun:** `mise run test:logged -- --name worktree-signal-isolated -- bun test --cwd apps/backend ./src/core/container-worktree-signal-install.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed unchanged, exit 0 (78.5 s logged).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.wMbwCL/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and adjacent `summary.json`.
- **Assessment:** recurrence confirmed by the complete owning-file pass. The ordering-race hypothesis remains unconfirmed. No worktree-signal implementation, assertion, deadline or skip changed.

## Remote host upgrades main merge — 2026-10-26

The aggregate repeated the missing `ready` ring (81.74 ms). The complete unchanged owner passed alone in 72.2 seconds. Commands, worker configuration, counts and evidence are recorded in [1009](../aggregate-validation-runs/1009-remote-host-main-merge-validation.md). No implementation, assertion, deadline or skip changed.

## Arch Linux temp-dir sweep recurrence — 2026-10-29

- **Original command:** `ORKESTRATOR_TEST_TIER=all TMPDIR=<private> mise exec -- bun run --cwd apps/backend test:workspace` on `todo-0247-test-temp-dir-leaks-e39ce75c81ca` at `45597dc26` (test cleanup only; no worktree-signal code), omarchy-hp, Arch Linux x86_64, Bun 1.4.4, load average 3 to 19.
- **Failure:** the same assertion, now at line 339, received `["lost"]` instead of `["lost", "ready"]` after 58.14 ms.
- **Suite counts:** backend 13,022 passed, 154 skipped, two failed across 13,178 tests in 798 files (682.75 s). The other failure was the `storage-writer-guards.test.ts` deadline already recorded in aggregate cases 1003, 1010 and 1166.
- **Isolated rerun:** `mise exec -- bun test --preload ../../tests/setup-node.ts src/core/container-worktree-signal-install.test.ts` from `apps/backend`, under a private `TMPDIR`, passed 13 of 13. The backend re-sweep at `f1fd52100` passed it too (13,025 passed, 0 failed).

