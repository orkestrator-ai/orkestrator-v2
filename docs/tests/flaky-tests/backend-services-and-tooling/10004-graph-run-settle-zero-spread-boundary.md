# Graph run settle cadence: a zero per-run spread lands the observation on the test's window edge

- **ID:** 10004
- **Status:** resolved
- **Date observed:** 2026-11-19
- **Test:** `graph run result settle cadence (#2131) > without a result, a turn
  that ends silently waits for the observation cadence`
- **File:** `apps/backend/src/core/graph-run-result-settle.test.ts:131`
- **Original command:** GitHub Actions CI, job "Tests (backend)" (`mise run
  test:full`, backend group, `ubuntu-latest`) on PR #2479
  (`environment-list-redesign-e425836cac68-r1`), run 44587253786, job
  135783439417. Base commit `5e9835d0a6`.
- **Failure:** `expect(received).toBe(expected)`, Expected `"running"`,
  Received `"complete"`, after 206.76 ms. The backend group finished in
  874.8 s with this as its only failure.
- **Isolated rerun:** the runner's own rerun of the unchanged file passed
  alone (1.3 s). Locally, `bun test src/core/graph-run-result-settle.test.ts
  --rerun-each=40` (from `apps/backend`) passed 120 of 120.

## Resolution (2026-11-19)

- **Root cause:** a test-window boundary, not load. The run's next
  observation is due one cadence (3000 ms) after its last observation at
  manual time 0, plus `stableSpreadMs(run.id, 1000)`, a hash of the run's
  random id in [0, 1000). `started()` leaves the clock at 2000 ms and the
  test then advanced exactly 1000 ms, so for the one run id in a thousand
  whose spread is 0 the observation fell due at 3000 ms, the window's last
  instant, and completed the turn before the "still running" check.
- **Fix:** the test advances `GRAPH_RUN_OBSERVATION_MS - STARTED_AT_MS - 50`
  (one 50 ms step short of the cadence), so the check never lands on the
  earliest possible due time. No assertion and no product code changed.
- **Reproduced:** yes. Temporarily making `stableSpreadMs` return 0 failed
  the unchanged test with the same `Expected "running", Received "complete"`;
  spreads of 1, 49, 50, 51, 249, 250, 251 and 500 passed. After the fix the
  file passed 3 of 3 with the spread forced to 0, 1 and 999.
- **Stress:** `bun test src/core/graph-run-result-settle.test.ts
  --rerun-each=40` (from `apps/backend`) passed 120 of 120 before the fix;
  the forced-spread runs above are the stronger evidence.
