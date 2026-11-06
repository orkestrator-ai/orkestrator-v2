# Direct terminal stream reconnects once after its listener leaves in aggregate

- **ID:** 5106
- **Status:** resolved
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

### Resolution — 2026-11-06

**Root cause.** Cross-test leakage through `globalThis.fetch`, not the
reconnect scheduling under test. Tests in the same file create gateways with
`browserSessionActivity` on a same-origin client and never dispose them. Each
such gateway runs a cookie-session probe whose failure path retries on a real
timer (1 s, 2 s, 4 s, … up to 30 s) for ever, and also leaves window
listeners. When that timer fires during a later test it calls whatever
`fetch` mock that test installed, so the later test counts a foreign
`GET /__orkestrator/session` as one of its own stream attempts.
Reproduced before the fix with temporary instrumentation: 1 failure in 30 and
1 in 60 runs of the owner under six CPU burners; the extra request was
`/__orkestrator/session` from `detectBrowserSession`'s `probe`, fired from a
happy-dom timer (once in this test's slow-stream check, once in the sibling
`retries the direct terminal stream after non-ok and bodyless responses`).

**Fix.** `apps/web/src/lib/native/web-gateway.ts` exports
`disposeBrowserGatewayApi(api, reason?)`, which runs (once) the disposer the
gateway already registered; `installBrowserGatewayApi` uses it when replacing a
gateway. `apps/web/src/lib/native/web-gateway.test.ts` wraps
`createBrowserGatewayApi` and `installBrowserGatewayApi` so every gateway a test
makes is disposed in `afterEach`, before `fetch` is restored. No assertion,
delay or timeout changed.

**Verification.**
- `NODE_ENV=test mise run test:logged -- --name gw-fix-loop2 -- /tmp/claude-1000/flk/loop.sh 60 apps/web ./src/lib/native/web-gateway.test.ts`
  (60 sequential runs of the complete owner, five CPU burners): PASS, 0
  failures in 60.
- `NODE_ENV=test mise run test:logged -- --name gw-fix-rerun -- bun test --cwd apps/web ./src/lib/native/web-gateway.test.ts --rerun-each=10`:
  PASS. Before the fix the same `--rerun-each` run failed
  `retries a network startup probe after connectivity returns` on every rerun
  after the first (14 of 15) for the same leak.
- `bun run --cwd apps/web typecheck`: no findings in the gateway files (the
  run's two errors are in `src/App.test.tsx`, another change in this worktree).
