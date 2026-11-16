# Rewrite idle deadline ends the body 342 ms after the last chunk, under load (`apps/backend/tests/gateway-proxy-idle-timers.test.ts`)

- **ID:** 9992
- **Status:** resolved
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

## Resolution (2026-11-15)

- **Root cause:** the test measured `Date.now() - lastChunkAt >= IDLE_MS` across two processes' scheduling. The deadline is one timer that each chunk moves with `timer.refresh()`, and a refreshed timer starts from the runtime's cached loop time, which a starved process can leave behind the wall clock; the second chunk can also be read late. So the elapsed time depends on the host, not on whether the deadline moved.
- **Fix:** `apps/backend/tests/gateway-proxy-idle-timers.test.ts` counts the moves instead of timing them: the idle-timer probe wraps `refresh()` on the one timer created at `IDLE_MS`, and the case asserts the 502 stall, one idle timer, at least one refresh, and that the upstream wrote its second chunk. That the moved deadline outlasts its own length is still proved by the sibling "steady body" case (ten chunks 60 ms apart past a 431 ms deadline).
- **Reproduced:** no — the 342 ms measurement was not re-created.
- **Product note:** a gateway starved for longer than its idle deadline may treat an unread chunk as silence; with the production deadline this needs a stall far beyond this test's, and it is not changed here.
- **Stress:** `mise run test:logged -- --name f2-cont-gw -- bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/gateway-proxy-idle-timers.test.ts -t "silence after a chunk" --rerun-each=3` passed (163 s).
