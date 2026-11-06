# Direct reconnect notification observes an extra attempt in aggregate

- **ID:** 6382
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Test:** `web gateway browser API > reconciles only fresh streams and explicit replay misses across direct reconnects`
- **File:** `apps/web/src/lib/native/web-gateway.test.ts:3167`
- **Original command:** `mise run test` at `f8ce680624a7b912fa227c3b36192cb7881e8fc0`; concurrent aggregate groups, worker grants not established from the captured output.
- **Failure:** expected reconnect attempt 4, received 5 (12.46 ms).
- **Suite counts:** captured backend/web summaries total 29,090 passes, two failures and 142 skips; the aggregate was incomplete because bridges never obtained capacity.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-33109580-25be-430c-acf4-c16e7bcdecd1/validation-04.stdout.txt`.
- **Isolated rerun:** `mise run test:logged -- --name gateway-owner-focused -- env NODE_ENV=test bun test --cwd apps/web ./src/lib/native/web-gateway.test.ts --parallel=1 --only-failures` passed the unchanged complete owner, exit 0, in 2.4 s. Passing output was deleted by the logged runner.
- **Assessment:** aggregate/isolated difference confirmed; cause unconfirmed. Preparation triage marked this related only because the test references changed prose in `docs/architecture/federation.md`. No gateway implementation or assertions changed. Preserve the assertions; investigate reconnect scheduling and competing async work before assigning a cause.

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
