# A probe that comes back early is spaced, one probe in the budget (apps/backend/tests/container-readiness.test.ts)

- **ID:** 1490
- **Status:** open
- **Test:** `bounded in-container boot wait > a probe that comes back early without a final state is spaced, not repeated at once`
- **Date observed:** 2026-10-31
- **Original command:** `mise run test`
- **Worker configuration:** backend workspace `bun test` at 4x parallel, on mbp3 with other workers running at the same time
- **Failure:** `expect(execs).toBeGreaterThanOrEqual(2)` received 1 (duration: 2.16 s)
- **Suite counts:** backend 11778 total, 11673 passed, 103 skipped, 2 failed
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./tests/container-readiness.test.ts` from `apps/backend`, three times → passed each time (20 pass, 0 fail)
- **Hypothesis:** the test gives the wait a 450 ms budget and needs two probes to fit inside it, each spawning a fake `docker` shell script. The failing case took 2.16 s in all, so on a loaded host the first probe used up the budget. Not reproduced under controlled load. The same test passed in the run before it. The change on the branch (retiring the legacy close fallback) does not touch this code.

## Provider parity main merge recurrence — 2026-10-31

- **Original command:** `mise run test:logged -- --name merge-default-tests -- mise run test`, merging main at `751b971623` into `agent-provider-parity-b3e549e90812-r1`.
- **Worker configuration:** workspace/root/bridges/protocol reservations 6/1/2/1; backend 4x parallel, Bun 1.4.4. About 182 seconds waiting for the host scheduler, 710.6 seconds overall.
- **Failure:** the same bounded-wait case expected at least two probes and received one (452.65 ms). Backend counts: 11,883 passed, 103 skipped and four failed across 11,990 tests in 812 files (266.84 s).
- **First unchanged owner rerun:** `mise run test:logged -- --name merge-container-readiness-owner -- bun test --cwd apps/backend ./tests/container-readiness.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` also failed while the aggregate was running: 19 passed, one failed (11.3 s); the case took 545.24 ms and recorded one probe.
- **After the aggregate completed:** `mise run test:logged -- --name merge-container-readiness-after-aggregate -- bun test --cwd apps/backend ./tests/container-readiness.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 (7.6 s).
- **Evidence:** `orkestrator-test-run.LzSOdM/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`, enclosing `orkestrator-test-run.WvH9mv/merge-default-tests.log.gz`, and the first owner rerun in `orkestrator-test-run.cSDOnQ`, under the host temporary directory.
- **Assessment:** host contention is consistent with the result, but remains unconfirmed. The owner, readiness implementation and lifecycle fixtures matched the original main merge parent exactly; no implementation, assertion, deadline or skip changed. The aggregate remains non-green.

Seen again on 2026-11-02 in the shared-logger bridge migration: `mise run test`, in the workspace group, expected at least 2 and received 1 after 453.07 ms. The owner then passed alone three times on the branch and three times on `f80a181e6` (20 pass, 0 fail each), with the host at a load average near 26:

```sh
cd apps/backend && bun test ./tests/container-readiness.test.ts --preload ../../tests/setup-node.ts --only-failures
```

That change does not touch this test or its readiness code, so this adds a sighting, not a cause.
