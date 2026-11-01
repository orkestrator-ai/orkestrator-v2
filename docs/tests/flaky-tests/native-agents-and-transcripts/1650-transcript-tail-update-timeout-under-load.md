# Transcript tail update tests time out under load

- **ID:** 1650
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `build pipeline transcript checkpoints > an active tail update writes one tail chunk, a manifest and the small control record`; `BuildPipelineTranscriptStore > an active tail update writes only the tail chunk and the manifest row`
- **File:** `apps/backend/src/core/build-pipeline-transcript-checkpoints.test.ts`, `apps/backend/src/core/build-pipeline-transcript-store.test.ts`
- **Original command:** `bun test --preload ../../tests/setup-node.ts --parallel=4 --only-failures <110 backend files>` from `apps/backend`, on branch `select-soonest-reset-76510e6abff6-r1` (macOS arm64, Bun 1.4.4), with the worktree on an external volume, beside other work on the host.
- **Failure:** both exceeded the default 5,000 ms (5,000 ms and 5,183 ms). The store test's `commit` then threw `RangeError: Cannot use a closed database` between tests, because its fixture had closed the database under the late call.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/build-pipeline-transcript-checkpoints.test.ts src/core/build-pipeline-transcript-store.test.ts src/core/control-mcp-coordinator-goals.test.ts --parallel=1` from `apps/backend`: 59 pass, 0 fail.
- **Assessment:** load on a slow disk rather than a defect in the change that saw it, which does not touch these paths. Open until it is seen again or a run on a local disk stays clean.
