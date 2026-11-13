# Rewrite idle deadline ends the body 342 ms after the last chunk, under load (`apps/backend/tests/gateway-proxy-idle-timers.test.ts`)

- **ID:** 9993
- **Status:** open
- **Date observed:** 2026-11-13
- **Base:** `263eea27df362cf541cb9bde9adf7ec4fec1f5fd`.
- **Observed head:** branch `test-core-count-2ea1f7178998-r1` at `5da57d190`
  (test wall-time work: test splits, injected test intervals, scheduler CPU
  learning). It does not touch the gateway, `gateway-test-harness.ts` or
  `apps/backend/tests/gateway-proxy-idle-timers.test.ts`. Its only change on
  that test's import path is `asyncUtilInterval: 10` in
  `tests/bounded-test-diagnostics.ts`, which configures
  `@testing-library/dom`'s `waitFor`; this test never calls `waitFor`.
- **Test:** `browser preview rewrite idle deadline > silence after a chunk still ends the body at the deadline`
  (`apps/backend/tests/gateway-proxy-idle-timers.test.ts:108`).
- **Failure:** `expect(Date.now() - lastChunkAt).toBeGreaterThanOrEqual(IDLE_MS)`
  expected `>= 431`, received `342` (520.04 ms). The 502 stall response
  arrived 342 ms after the test recorded writing the second chunk, so the
  deadline was not measured from that chunk.
- **Original command:** Multi Review preparation's `mise run test:full`
  (default worker plan, exit 1 after 1162.1 s) on a Linux host shared with
  other worktrees' validation. The same run also failed the WebKit engine
  parts (missing host libraries), `useVirtuosoScrollState.return.test.ts`
  (repaired in the same branch) and two cases that fail on the target
  branch's CI.
- **Isolated rerun:** `mise run test:logged -- --name gateway-idle-alone-<n> -- bun test --cwd apps/backend ./tests/gateway-proxy-idle-timers.test.ts --preload ../../tests/setup-node.ts --parallel=1`
  passed unchanged three times out of three, 3.0 s each.
- **Evidence:** `validation-10.stdout.txt` in that review's validation
  artifacts (`.orkestrator/review-artifacts/review-validation-16cde985-…`).

## Hypothesis

Not established. The gateway and the upstream fixture run in the test's own
process. 342 ms is about the 431 ms deadline minus the 60 ms sleep between
the chunks plus scheduling delay, which fits a deadline still timed from the
first chunk. One explanation: the process was starved of CPU after the second
chunk was written, and when it ran again Node's timers phase fired the idle
deadline before the poll phase delivered the already-written chunk. If so,
a gateway starved for longer than its idle deadline would treat a chunk it
has not yet read as silence. That is worth checking against the production
deadline before the test is changed. No test, assertion, timeout or skip was
changed.
