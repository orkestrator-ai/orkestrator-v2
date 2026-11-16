# Chromium shell policy test stalls in the aggregate

- **ID:** 9878
- **Status:** open
- **Date observed:** 2026-10-22
- **Test:** `executable document policy in chromium > through the shell, every self-navigation, popup, form and redirect reaches the sink zero times`
- **Owning file:** `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts`
- **Original command:** `mise run test:logged -- --name recurring-full-suite -- mise run test`
- **Worker configuration:** default aggregate workspace/root/bridges/protocol groups, bounded package workers.
- **Failure:** test exceeded its 240000 ms timeout with a reported duration of 1015384.39 ms. Workspace no-progress watchdog fired after 300000 ms without output. Aggregate exited 1 after 1095.2 seconds; root independently stalled in the EnvironmentItem tooltip case (0671). Complete backend counts were unavailable because the group was terminated.
- **Isolated rerun:** `mise run test:logged -- --name artifact-engines-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/content-server.engines.test.ts --parallel=1 --only-failures` passed the complete unchanged owning file (exit 0, 76.3 seconds logged).
- **Evidence:** `orkestrator-test-run.GB1K1o/recurring-full-suite.log.gz` and the inner aggregate's `orkestrator-test-run.IGYJrv` below the host temporary directory.
- **Hypothesis:** simultaneous long stalls in independent groups suggest delayed timers or host scheduling, but the exact cause is unproven. There was no assertion showing a dropped real click (resolved case 0505) or an unnamed hook timeout (0507). No policy implementation, assertion, deadline or skip changed.

- **Aggregate retry:** `mise run test:logged -- --name recurring-full-suite-final -- mise run test` passed every non-iOS group (exit 0, 437.1 seconds logged), without changing either failing owner. The flake remains open because the underlying cause has not been fixed.

## Investigation — 2026-11-15 (still open)

- **Owner moved:** dc90609bf split `content-server.engines.test.ts` into per-engine files. This test is now defined in `content-server.engines-lane-3-test-support.ts` and runs from `content-server.engines-{chromium,firefox,webkit}-3.test.ts`.
- **Not a deadline flake:** the recorded failure is a stall. The 240 s test timeout was reported at 1,015 s while the workspace no-progress watchdog fired, and the root group stalled at the same time. A timer firing about 775 s late means the process was not running its event loop, which no test-side wait explains. The cause is not established, so the case stays open.
- **Timed check removed:** the control phase waited for each attack's positive hit with a 5 s deadline and swallowed the timeout, so a starved host could fail `control.observed[attack] > 0`. That wait now has a 30 s hang watchdog and still ends on the hit itself. The negative `pause(2_000)` no-hit window before `shell.observed[attack] === 0` is unchanged. A late hit there can only make the test pass wrongly, never fail it.
- **Check:** `mise run test:logged -- --name c9878 -- bun scripts/test-under-contention.ts --core 12 --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/content-server.engines-chromium-3.test.ts -t "every self-navigation" --rerun-each=3` passed (102.8 s). The stall was not reproduced.
