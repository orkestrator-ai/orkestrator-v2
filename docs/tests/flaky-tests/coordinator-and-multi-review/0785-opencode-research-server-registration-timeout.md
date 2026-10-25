# OpenCode coordinator research-server registration timeout

- **ID:** 0785
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `OpenCode coordinator research servers > registers a research server and allows exactly its tools`
- **Owning file:** `apps/backend/src/core/opencode-coordinator-research-live.test.ts`
- **Parents:** feature `2e7edbc161b60cb188437783168f8bc8135f5953` and main `95c9cb46ae0a2b12fbc10ff73fa7c0614b254a0d`.
- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=0014505caeed69395b3cc996dd541fcc6df12c23 mise run test:logged -- --name refresh-0043-suite -- mise run test`.
- **Worker configuration:** default 4/1/2/1 workspace/root/bridge/protocol reservations; two backend Bun workers, alongside browser and Electron checks.
- **Failure:** the case exceeded its 40-second outer deadline (40,001.72 ms), with one dangling process killed. It drives a real pinned `opencode serve` and local MCP fixtures without a model service.
- **Suite counts:** backend: 10,857 passed, 117 skipped and two failed across 650 files (572.16 s). The second failure was an unrelated tmux teardown assertion.
- **Complete unchanged owner:** `mise run test:logged -- --name refresh-0043-research-live-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/opencode-coordinator-research-live.test.ts --parallel=1 --only-failures` passed (exit 0, 1.5 s).
- **Evidence:** `orkestrator-test-run.fqu9cJ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** an aggregate-specific timeout, confirmed by the unchanged complete owner pass. No narrower root cause has been established. No implementation, assertion, deadline or skip changed.

## Recurrence — 2026-10-25

- Command: `mise run test:logged -- --name full-test-2 -- mise run test` on branch `todo-0054-design-a11y-findings-ec88681caf58` (`ba7cc8d4` plus the design-canvas accessibility working tree, which touches only `apps/web/src/components/design/`, its tests and two `e2e/` specs, not this test's code), macOS 27.0 arm64, default `mise run test` groups, host load average 55 to 66. The same suite's first run on this branch, an hour earlier, passed the workspace group.
- Failure: the case exceeded its 40-second outer deadline (40,000.38 ms). Backend: 10,457 passed, 79 skipped and 2 failed across 10,538 tests in 615 files (853.45 s); the other failure was the 0165 coordinator unborn-HEAD timeout.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.MUtdn0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Complete unchanged owner: `mise run test:logged -- --name opencode-research-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/opencode-coordinator-research-live.test.ts --parallel=1 --only-failures` passed (exit 0, 6.2 s).
- Assessment: a second aggregate-only timeout under heavy load. Still open; no implementation, assertion, deadline or skip changed.
