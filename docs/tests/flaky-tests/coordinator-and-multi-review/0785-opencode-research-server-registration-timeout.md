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
