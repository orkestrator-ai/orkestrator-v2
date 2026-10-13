# Annotation quota fixture hook timeout

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
