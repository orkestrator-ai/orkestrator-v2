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

## Merge 487cb02be recurrence, 2026-11-05

`mise run test:logged -- --name merge-suite -- mise run test` failed after
537.0 seconds, including 103.0 seconds in the host queue. Workspace/root/bridge/
protocol reservations were 6/1/2/1 slots. Web used two workers: 12,952 passed, 10 skipped, one failed across 859 files. The configured-delay check expected one attempt after a five-millisecond wait but received two (28.18 ms, line 4222). This recurrence failed before listener cleanup, unlike the original observation.

Complete unchanged owner rerun:
`NODE_ENV=test mise run test:logged -- --name merge-web-gateway-rerun -- bun test --cwd apps/web ./src/lib/native/web-gateway.test.ts --parallel=1 --only-failures`
passed (exit 0, 2.4 seconds; passing counts not retained). Evidence:
`/tmp/orkestrator-test-run.O57e2K/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The sole original merge conflict was the federated environment action hook;
this owner was not conflicted or manually edited. Root cause remains unconfirmed;
no implementation or assertion was changed. The aggregate remains non-green.

## Desktop relay address-stage recurrence — 2026-11-05

`mise run test:logged -- --name review-default-tests -- mise run test`
(workspace reservation six slots, web's default isolated workers) failed this
same test earlier in its lifecycle: at line 4222, the slow stream's attempt
count was two instead of one after the five-millisecond wait (8.63 ms).
The root and bridge groups were running concurrently after a 914-second
admission wait. Evidence is the workspace log under
`/tmp/orkestrator-test-run.l79QN0/` (compressed by the aggregate on completion).

The complete unchanged owner passed with
`NODE_ENV=test mise run test:logged -- --name fix-web-gateway-owner -- bun test --cwd apps/web ./src/lib/native/web-gateway.test.ts --parallel=1 --only-failures`
(exit 0, 3.3 s). This observation establishes another aggregate/isolated
difference, not a cause. The branch changes relayed stream handling in
`web-gateway.ts`, so the result is not excused as unrelated; full validation
remains outstanding. Neither this test nor its terminal-stream implementation
was changed to mask the failure.
