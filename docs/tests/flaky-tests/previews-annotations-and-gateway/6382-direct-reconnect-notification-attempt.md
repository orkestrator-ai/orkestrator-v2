# Direct reconnect notification observes an extra attempt in aggregate

- **ID:** 6382
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `web gateway browser API > reconciles only fresh streams and explicit replay misses across direct reconnects`
- **File:** `apps/web/src/lib/native/web-gateway.test.ts:3167`
- **Original command:** `mise run test` at `f8ce680624a7b912fa227c3b36192cb7881e8fc0`; concurrent aggregate groups, worker grants not established from the captured output.
- **Failure:** expected reconnect attempt 4, received 5 (12.46 ms).
- **Suite counts:** captured backend/web summaries total 29,090 passes, two failures and 142 skips; the aggregate was incomplete because bridges never obtained capacity.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-33109580-25be-430c-acf4-c16e7bcdecd1/validation-04.stdout.txt`.
- **Isolated rerun:** `mise run test:logged -- --name gateway-owner-focused -- env NODE_ENV=test bun test --cwd apps/web ./src/lib/native/web-gateway.test.ts --parallel=1 --only-failures` passed the unchanged complete owner, exit 0, in 2.4 s. Passing output was deleted by the logged runner.
- **Assessment:** aggregate/isolated difference confirmed; cause unconfirmed. Preparation triage marked this related only because the test references changed prose in `docs/architecture/federation.md`. No gateway implementation or assertions changed. Preserve the assertions; investigate reconnect scheduling and competing async work before assigning a cause.
