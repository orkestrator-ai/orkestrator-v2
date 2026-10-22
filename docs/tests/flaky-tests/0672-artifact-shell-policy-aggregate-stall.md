# Chromium shell policy test stalls in the aggregate

- **ID:** 0672
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
