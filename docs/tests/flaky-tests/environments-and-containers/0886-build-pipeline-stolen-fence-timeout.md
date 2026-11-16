# Build pipeline stolen-fence interaction test timed out under aggregate load

- **ID:** 0886
- **Status:** resolved
- **Date observed:** 2026-10-25
- **Test:** `BuildPipelineService > refuses to record an interaction outcome through a stolen fence`
- **File:** `apps/backend/src/core/build-pipeline-service-interactions.test.ts`
- **Change under test:** todo 0121 (Claude plugin MCP servers in the editor), which does not touch build pipelines.
- **Original command:** `cd apps/backend && bun test --preload ../../tests/setup-node.ts src tests --parallel=4` (four backend workers; the host also ran an isolated `dev:test` profile).
- **Aggregate result:** timed out after 5,000 ms (5,980.26 ms reported). Backend totals: 11,302 passed, 85 skipped, 13 failed.
- **Unchanged owner rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/build-pipeline-service-interactions.test.ts` from `apps/backend` passed (41 pass, 0 fail).
- **Hypothesis:** host load stretched the test past Bun's five-second default. Unproven; no implementation, assertion, timeout or skip changed.

## Resolution (2026-11-15)

- **Root cause:** The stolen-fence case drives SQLite storage and leases; it exceeded Bun's 5 s default in a four-worker run.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The owning file sets no smaller file, test or hook budget, and the failing test has no inner wall-clock deadline of its own.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-b -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 13 --burners 6 -- bun test --preload ../../tests/setup-node.ts <seventeen container, pipeline, move, worktree and native-agent owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 1,139 passed, 1 failed — `git fsmonitor > fixture repositories inherit fsmonitor off from the test preload` on its second rerun, which fails the same way without contention and with the unchanged file (`git-fsmonitor.test.ts` is not rerun-safe).
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
