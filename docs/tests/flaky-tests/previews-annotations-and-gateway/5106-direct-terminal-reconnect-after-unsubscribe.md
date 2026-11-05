# Direct terminal stream reconnects once after its listener leaves in aggregate

- **ID:** 5106
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `web gateway browser API > reconnects a direct terminal stream on its configured delay and stops once its listener leaves`
- **File:** `apps/web/src/lib/native/web-gateway.test.ts:4233`
- **Original command:** `mise run test` at `8d08eaa27`; workspace/root/bridges/protocol reservations 6/1/2/1, with web using two isolated Bun workers. Workspace waited 1112.6 seconds for shared capacity.
- **Failure:** the attempt count was 4 when the listener stopped and 5 after the five-millisecond wait; the failing case took 17.01 ms. Web reported 12,489 passed, 10 skipped and one failed.
- **Owning-file rerun:** `NODE_ENV=test mise run test:logged -- --name fixes-web-gateway-isolated -- bun test --cwd apps/web ./src/lib/native/web-gateway.test.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0, in 2.3 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.b2h5jF/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and adjacent `summary.json`. Passing owner output was deleted by the bounded logger.
- **Assessment:** confirmed aggregate/isolated difference; root cause unknown. The branch changes coordinator launch/replay handling and Pi history cancellation, with no web gateway or desktop code changes. No implementation, assertion, timer or skip in this owner changed.
- **Investigation:** the test uses a zero-delay reconnect loop, waits until at least four attempts, then stops the listener and expects the count to stay fixed after five milliseconds. This observation does not establish whether a request was already in flight or why the aggregate differs.
- **Next step:** investigate the stop/reconnect scheduling boundary with a controlled clock and deferred fetch completion before changing the implementation or assertion.
