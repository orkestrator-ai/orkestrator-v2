# Change-tracking deadline wall-clock bound under aggregate load

- **ID:** 0512
- **Status:** resolved
- **Date observed:** 2026-10-21
- **Test:** `foreground and queued deadlines settle while inventory is blocked and fence late publication`
- **File:** `apps/backend/src/core/change-tracking/review-regressions.test.ts:142`
- **Original command:** `mise run test:logged -- --name federation-tests -- mise run test` (complete non-iOS suite; the backend `test:workspace` group ran concurrently with the root, bridge and protocol groups).
- **Worker configuration:** default `scripts/test-all.ts` planning on the development Mac; worker counts not captured.
- **Failure:** `expect(Date.now() - started).toBeLessThan(300)` received 360 ms; the test took 1882 ms in the aggregate run.
- **Suite counts:** backend `test:workspace` reported 1 fail; exact pass counts were not captured.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/change-tracking/review-regressions.test.ts` from `apps/backend` passed (21 pass, 0 fail).
- **Evidence:** `orkestrator-test-run.j9cRI6/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.
- **Hypothesis:** the 300 ms wall-clock bound on two 30–40 ms capture deadlines is exceeded when the host is saturated by the concurrent suite groups. The change under test (federated multi-backend client) does not touch change tracking. No implementation, assertion, timeout or skip changed.

## Resolution (2026-11-10)

- **Root cause:** the test, not the product. It bounded two capture deadlines
  (30 ms and 40 ms) with `expect(Date.now() - started).toBeLessThan(300)`, a
  wall-clock assertion on when real timers fire. A worker descheduled for a few
  hundred milliseconds fires them late, which is the recorded 360 ms. The
  trailing fence check also slept a fixed 80 ms before its negative assertion.
- **Fix:** `apps/backend/src/core/change-tracking/review-regressions.test.ts`
  runs both deadlines on controlled time (`installControlledTimeout` at 30 ms,
  which also holds the running capture's abort timer, and at 40 ms). It checks
  both are armed, advances each in turn, and asserts each settles as
  `capture-timeout` while inventory is still blocked. This is stronger than
  the old bound: it proves which timer settles which capture. After the gate
  opens, the test waits for the owner to go idle with no reserved capture
  attempt (`idleFor`, `ledger.pendingCaptures()`) before checking that nothing
  was published, instead of sleeping 80 ms.
- **Reproduced:** yes. A temporary `Bun.sleepSync(320)` after the two
  `capture` calls (a descheduled worker) failed the unchanged test with
  `Expected: < 300, Received: 332` (`b39-0512-repro`). With the fix and the
  same stall it passed (`b39-0512-fixed-stall`).
- **Stress:** `mise run test:logged -- --name b39-0512-stress -- bun scripts/test-under-contention.ts -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/change-tracking/review-regressions.test.ts --rerun-each=20`
  passed (whole owner, 20 reruns, 6 unpinned burners on macOS at a host load
  average of about 33 to 50).
