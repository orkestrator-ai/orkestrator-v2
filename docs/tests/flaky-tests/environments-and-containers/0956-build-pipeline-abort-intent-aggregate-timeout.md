# Build pipeline abort-intent test exceeded its deadline in a parallel backend run

- **ID:** 0956
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `BuildPipelineService > persists pause and cancel intent even when abort cannot be confirmed`
- **File:** `apps/backend/src/core/build-pipeline-service-supervisor.test.ts`
- **Change under test:** OpenCode attachment dispatch and CLI scenario tool installation; this test file was unchanged.
- **Original command:** `mise run test:logged -- --name focused-backend-review -- bun --cwd apps/backend test ./src/core/opencode-provider-dispatch.test.ts ./src/core/opencode-stream-state.test.ts ./src/core/native-agent-service-turn-outcome.test.ts ./src/core/native-agent-prompt-queue-dispatcher.test.ts --parallel=2 --only-failures`.
- **Worker configuration:** The `bun --cwd` form invoked the package's `test` script, which added `src tests` and ran the whole backend with two workers. Other worktrees were running repository validation on the shared host.
- **Observed failure:** Bun's 5,000 ms timeout, reported duration 5,831.19 ms. The accidentally broadened run was then stopped (exit 143), so complete suite counts are unavailable.
- **Failure artifact:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.hqWylN/focused-backend-review.log.gz`.
- **Isolated owner command:** `mise run test:logged -- --name isolated-supervisor-timeout -- sh -c 'cd apps/backend && bun test ./src/core/build-pipeline-service-supervisor.test.ts --parallel=1 --only-failures'`.
- **Isolated result:** Passed, exit 0, 7.5 seconds for the complete unchanged owner. The owner also passed in a five-file backend subset.
- **Hypothesis:** Shared-host contention stretched the test beyond its default deadline. This is unproven; no assertion, timeout, skip, or implementation was changed to hide the failure.
