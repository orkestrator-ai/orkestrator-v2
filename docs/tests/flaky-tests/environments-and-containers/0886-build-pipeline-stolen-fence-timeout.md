# Build pipeline stolen-fence interaction test timed out under aggregate load

- **ID:** 0886
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `BuildPipelineService > refuses to record an interaction outcome through a stolen fence`
- **File:** `apps/backend/src/core/build-pipeline-service-interactions.test.ts`
- **Change under test:** todo 0121 (Claude plugin MCP servers in the editor), which does not touch build pipelines.
- **Original command:** `cd apps/backend && bun test --preload ../../tests/setup-node.ts src tests --parallel=4` (four backend workers; the host also ran an isolated `dev:test` profile).
- **Aggregate result:** timed out after 5,000 ms (5,980.26 ms reported). Backend totals: 11,302 passed, 85 skipped, 13 failed.
- **Unchanged owner rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/build-pipeline-service-interactions.test.ts` from `apps/backend` passed (41 pass, 0 fail).
- **Hypothesis:** host load stretched the test past Bun's five-second default. Unproven; no implementation, assertion, timeout or skip changed.
