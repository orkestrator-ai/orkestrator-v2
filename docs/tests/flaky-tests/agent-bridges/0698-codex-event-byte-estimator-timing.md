# Codex event-byte estimator timing under aggregate load

- **ID:** 0698
- **Status:** open
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
