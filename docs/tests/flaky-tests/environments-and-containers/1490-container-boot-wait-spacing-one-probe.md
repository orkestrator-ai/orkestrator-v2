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
