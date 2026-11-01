# Coordinator tools list test times out under load

- **ID:** 1651
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `what a coordinator is offered > the main coordinator has the tools and a side agent does not`
- **File:** `apps/backend/src/core/control-mcp-coordinator-goals.test.ts`
- **Original command:** `bun test --preload ../../tests/setup-node.ts --parallel=4 --only-failures <110 backend files>` from `apps/backend`, on branch `select-soonest-reset-76510e6abff6-r1` (macOS arm64, Bun 1.4.4), with the worktree on an external volume, beside other work on the host.
- **Failure:** exceeded the default 5,000 ms (5,090 ms). Its `tools/list` then failed with `ECONNRESET` between tests, because the fixture had closed the server under the late call.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/build-pipeline-transcript-checkpoints.test.ts src/core/build-pipeline-transcript-store.test.ts src/core/control-mcp-coordinator-goals.test.ts --parallel=1` from `apps/backend`: 59 pass, 0 fail.
- **Assessment:** load on a slow disk rather than a defect in the change that saw it, which does not touch these paths. Open until it is seen again or a run on a local disk stays clean.
