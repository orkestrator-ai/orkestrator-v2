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

## Additional observation on 2026-10-13

- **ID:** 0204
- **Status:** open
- **Date observed:** 2026-10-13
- **Original command:** `mise run test:logged -- --name fix-full-suite -- mise run test`
- **Worker configuration:** normal aggregate allocation; backend used one Bun worker while root and bridge groups and component/isolated browser validation ran on the host.
- **Failure:** `environment quotas through the service > the request count quota refuses a send with usage totals and reserves nothing` in `apps/backend/src/core/web-annotation-quotas.test.ts` exhausted a beforeEach/afterEach hook timeout at 10005.53 ms.
- **Suite counts:** backend reported 5877 passed, 15 skipped and 25 failed; 22 failures were environment-move cleanup errors and two were keyed-scheduling timeouts.
- **Isolated rerun:** `mise run test:logged -- --name fix-quotas-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/web-annotation-quotas.test.ts --parallel=1 --only-failures` passed (exit 0, 2.4 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.Pv387k/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** fixture lifecycle work exceeded its deadline under aggregate load or shared backend activity. The owning test and backend were unchanged; the cause is unconfirmed. No test was skipped or timeout raised.
