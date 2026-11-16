# Build pipeline abort-intent test exceeded its deadline in a parallel backend run

- **ID:** 0956
- **Status:** resolved
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

## Resolution (2026-11-15)

- **Root cause:** The abort-intent case exceeded Bun's 5 s default (5,831 ms) under contention; it has no inner deadline.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The owning file sets no smaller file, test or hook budget, and the failing test has no inner wall-clock deadline of its own.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-b -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 13 --burners 6 -- bun test --preload ../../tests/setup-node.ts <seventeen container, pipeline, move, worktree and native-agent owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 1,139 passed, 1 failed — `git fsmonitor > fixture repositories inherit fsmonitor off from the test preload` on its second rerun, which fails the same way without contention and with the unchanged file (`git-fsmonitor.test.ts` is not rerun-safe).
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
