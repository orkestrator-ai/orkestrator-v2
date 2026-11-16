# Preview runaway: the healthy job after an unbounded allocation times out

- **ID:** 1006
- **Status:** resolved
- **Date observed:** 2026-10-26
- **Test:** `runaway execution (process isolation) > unbounded memory allocation: ends within the deadline, the boundary is gone, the next job succeeds`
- **Owning file:** `apps/backend/src/core/transcript-artifacts/preview-runaway.test.ts:315`
- **Original command:** `mise run test` on branch `todo-0033-remote-host-upgrades-e94b3d6c2a08` (base `93018933`), Bun 1.4.4 on Arch Linux x64 (omarchy-hp), default workspace/root/bridges/protocol reservations, host load average 15–17 with other worktrees running suites. The diff touches no transcript-artifact code.
- **Failure:** after 6,685.06 ms, `expect(healthy.ok).toBe(true)` received `false`. The healthy job after the runaway one reported `render_timeout` ("The interactive document did not become ready in time", retry class `after-edit`).
- **Suite counts:** backend 11,709 passed, 142 skipped, 4 failed across 11,855 tests in 703 files (731.65 s).
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts --parallel=2 src/core/transcript-artifacts/preview-runaway.test.ts` from `apps/backend`: 5 passed.
- **Evidence:** `/tmp/orkestrator-test-run.s0jA9M/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` on omarchy-hp.
- **Hypothesis:** host contention (and the memory the runaway case just allocated) slowing the next preview process past its readiness deadline. Not confirmed.

## Resolution (2026-11-15)

- **Class:** product deadlines in the test configuration decided the outcome (B).
- **Root cause:** the suite set `readinessMs: 5_000`, `workerWallMs: 15_000` and `operationDeadlineMs: 25_000`. Right after the runaway allocation, a CPU-starved host delays the next Chromium launch, so the healthy job lost the 5 s readiness race and reported `render_timeout`. The 15 s wall could also preempt the memory watchdog, so the runaway case would see `wall` where it expects `worker-memory`. `assertRecovered` polled with a 20 s deadline.
- **Fix (`apps/backend/src/core/transcript-artifacts/preview-runaway.test.ts`):**
  - The budgets are now readiness 30 s, wall 90 s and operation 120 s. They are documented as hang watchdogs: each case ends on its own signal (the memory watchdog, the DOM limit, the probe step deadline, the readiness handshake).
  - The recovery wait's bound is 90 s, and the test's third argument is 480 s.
  - Every assertion is unchanged, including the expected end reason for each runaway.
- **Reproduced:** no. The unchanged file passed under `--core 12 --burners 6 --rerun-each=2` (193.1 s).
- **Stress:** `mise run test:logged -- --name new1006 -- bun scripts/test-under-contention.ts --core 12 --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/preview-runaway.test.ts --rerun-each=2` passed (197.4 s). The container-mode cases were skipped because the worker image is absent on this host.
- **Note:** raising the budgets is the weaker kind of fix the registry describes. It holds only because they are product watchdogs that no assertion measures. A deterministic readiness signal would need a runner hook the product does not expose.
