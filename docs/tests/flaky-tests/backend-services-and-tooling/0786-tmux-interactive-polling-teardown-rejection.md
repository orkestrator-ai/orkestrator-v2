# Interactive tmux polling teardown rejects cleanup

- **ID:** 0786
- **Status:** open
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
