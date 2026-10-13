# Web annotation quota hook timeout under aggregate load

- **ID:** 0204
- **Status:** open
- **Date observed:** 2026-10-13
- **Test:** `environment quotas through the service > the request count quota refuses a send with usage totals and reserves nothing`.
- **Owning file:** `apps/backend/src/core/web-annotation-quotas.test.ts`.
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`,
  with the documented macOS GNU-tool PATH.
- **Worker configuration:** workspace packages `--parallel=1`, two package
  tasks; root, bridge and protocol groups also ran on the host.
- **Failure:** a beforeEach/afterEach hook exceeded its 10,000 ms deadline,
  reported at 10,000.19 ms.
- **Backend suite:** 5,875 passed, 15 skipped, 27 failed across 329 files in
  442.53 seconds; 22 failures reproduced as tmux cleanup errors on this host.
- **Isolated rerun:** with the same PATH,
  `mise run test:logged -- --name quotas-rerun -- bun --cwd=apps/backend test ./src/core/web-annotation-quotas.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed unchanged (exit 0) in 5.1 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.TrudTm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The isolated pass supports a load-sensitive fixture setup or cleanup timeout;
the evidence does not establish which hook stalled. No test assertions, deadlines
or skips were changed.
