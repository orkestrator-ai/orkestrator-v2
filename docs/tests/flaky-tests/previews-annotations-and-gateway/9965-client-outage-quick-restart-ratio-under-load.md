# Client outage: quick-restart reconnect ratio misses on a loaded host

- **ID:** 9965
- **Status:** open
- **Date observed:** 2026-11-11

Test: `quick backend restarts: first reconnect against the banner's delay`
in `e2e/agent-testing/client-outage.spec.ts` (opt-in live spec,
`ORKESTRATOR_AGENT_TEST_LIVE_OUTAGE=1`).

## Observation

- **Host and branch:** beelink2 (Linux), branch
  `beelink2-restart-failure-b5978072af7f-r1`, base `963ffa6ab` (`main`). The
  branch fixes the spec's restart harness (to-do 7835, retired 2026-11-11) and
  moves the "To pipeline" toolbar poll onto the read coordinator; neither
  touches the reconnect ladder or the backend's start-up.
- **Original command:** the whole spec, one worker, on a disposable
  `dev:test --profile t7835-outage --fixture --no-agent-credentials
  --agent-platforms codex --headless` profile with
  `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`:
  `mise run test:logged -- --name t7835-full-2 -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts client-outage.spec.ts --workers=1`.
  Load average 28.8 at the start and 34.2 at the end.
- **Failure:** `expect(underDelay / all.length).toBeGreaterThan(0.5)`,
  received 0.4: 8 of 20 first reconnects landed inside the 4 s banner delay.
  The backend was down for 1,694 to 2,194 ms per restart, and first
  reconnects landed 3,235 to 5,890 ms after the stop.
- **Counts:** 10 passed, 1 failed, 13.0 min.

## Isolated rerun

`… client-outage.spec.ts --grep "quick backend" --workers=1` passed alone on
the same profile minutes later (load average 35.4 falling to 23.2): 11 of 20
under the delay, backend down 1,185 to 2,051 ms. Earlier the same day, at a
lower load, the four restart cases alone passed with the backend down 914 to
1,132 ms and 19 of 20 under the delay.

## Assessment

Hypothesis, supported by the three samples above but not proven: the rule
measures from the moment the spec stops the backend, so it includes the
replacement backend's own start-up. The event ladder's first rung lands 1 to
2 s after the drop; when start-up takes longer than that, the first answered
attempt is on the second rung, 3 to 6 s after the stop, and often past the
4 s banner delay. Start-up time follows host load. A user whose backend
restarts as slowly would see the banner flash on a quick restart, so this is
the product's behaviour under load, not only a slow test. No budget,
assertion or retry was changed for this record.

## Next evidence

If it recurs, compare `backendDownMs` with the 2026-10-31 run's restarts (not
recorded then) and decide, with that evidence, whether the rule should be
measured from the moment the backend listens, or whether the banner delay or
the ladder's first rung should change.
