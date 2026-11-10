# Codex event-byte estimator timing under aggregate load

- **ID:** 0698
- **Status:** resolved
- **Observed:** 2026-10-23
- **Test:** `estimateOrderedEventBytes > stops descending at the depth cap instead of walking forever`
- **Owner:** `bridges/codex-bridge/src/app-server-runtime-helpers.test.ts:198`
- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`
- **Workers:** workspace/root/bridge/protocol reservations 4/1/2/1; one Codex worker, alongside isolated browser validation and other worktrees on the shared host.
- **Failure:** elapsed time was 103.890875 ms against the 50 ms assertion; test duration 109.80 ms.
- **Suite counts:** Codex 2254 passed, 38 skipped, 2 failed across 84 files (59.49 s). The second failure was the known fake-process probe timeout, case 0210.
- **Unchanged owner rerun:** `mise run test:logged -- --name codex-depth-node -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/app-server-runtime-helpers.test.ts --parallel=1 --only-failures` passed (exit 0, 0.1 s logged).
- **Evidence:** `orkestrator-test-run.XHMi6K/bridges.log.gz` below the host temporary directory after aggregate completion.
- **Hypothesis:** process scheduling under concurrent host load can inflate a wall-clock performance assertion. The isolated pass establishes intermittence without identifying the source of the delay.
- **Disposition:** recorded without changing the implementation, assertion, deadline or skips.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** no commit has touched the owner since 2026-10-22. The wall-clock bound `expect(performance.now() - start).toBeLessThan(50)` is still at `app-server-runtime-helpers.test.ts:198`. The complete owner passed alone once today (10 pass, 73 ms; Bun 1.4.4, load average about 35).
- **Next step:** replace the wall-clock bound with a structural check (for example, count visited nodes through a test seam). The `estimate` bound on the next line already proves the depth cap.

## Resolution (2026-11-10)

- **Status:** resolved.
- **Root cause:** the test, not the product. It proved the depth cap with
  `expect(performance.now() - start).toBeLessThan(50)`, a wall-clock bound
  that measures how long the scheduler leaves the worker off-CPU as much as
  the walk itself. On a loaded host the 40-level walk took 103.9 ms.
- **Fix:** `app-server-runtime-helpers.test.ts` wraps every level in a Proxy
  whose `ownKeys` trap records the level the walk opens, and asserts the walk
  opened exactly levels `0..ORDERED_EVENT_ESTIMATE_MAX_DEPTH - 1`; the cyclic
  case asserts it opened exactly `ORDERED_EVENT_ESTIMATE_MAX_DEPTH` objects.
  The estimate bounds stay. No timing remains in the test.
- **Reproduced:** no — the failure was host scheduling against a 50 ms
  wall-clock bound, which the macOS contention runner cannot pin reliably.
  Instead the new assertion was checked against a broken cap: raising the
  cap in `estimateOrderedEventBytes` to 64 makes the test fail (the walk
  opens all 40 levels), and restoring it makes it pass.
- **Stress:** `mise run test:logged -- --name codex-helpers-0698 -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/app-server-runtime-helpers.test.ts --parallel=1 --rerun-each=50`
  passed (exit 0).
