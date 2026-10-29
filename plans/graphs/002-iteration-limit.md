---
id: 002
title: "Align the iteration limit"
phase: 0
plan: "P0.2"
status: done
depends_on: []
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1436"
updated: 2026-10-29
---

# 002 · Align the iteration limit

- **Plan:** [P0.2 Align the iteration limit](../composable-graphs.md#p02-align-the-iteration-limit)
- **Decisions:** none (report §2.7, finding 2)
- **Depends on:** none
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

The coordinator cannot request more pipeline iterations than the protocol accepts.

## Work

- [x] Use `MAX_BUILD_PIPELINE_ITERATIONS` in `control-mcp-coordinator-tools.ts:300` instead of the literal `20`.
- [x] Check the other callers (CLI, launch dialog, feature builds) for literal iteration limits and point them at the constant.

## Tests

- [x] A test pins the tool schema maximum to the protocol constant.

## Done when

- [x] A `launch_build` call asking for 11 iterations is refused by the tool schema with a clear message.

## Notes

- 2026-10-29: The coordinator tool is `start_build_pipeline` (registered in
  `apps/backend/src/core/control-mcp-coordinator-tools.ts`); there is no
  `launch_build` tool. The "Done when" line is read as that tool. Its
  `maxIterations` field is now
  `z.number().int().min(1).max(MAX_BUILD_PIPELINE_ITERATIONS, …)` with the
  error `maxIterations must be at most 10, the Build Pipeline's iteration
  limit.` and a description naming the range, so the published JSON schema
  carries `maximum: 10` and an 11-iteration call is refused before the backend
  command runs.
- 2026-10-29: No other caller sets a literal limit. The launch dialog, feature
  builds and the CLI never send `maxIterations`; the backend defaults it to 3
  (`build-pipeline-service-lifecycle.ts`), which is a default, not a limit.
  The protocol guards (`isStartBuildPipelineInput`, `isBuildPipeline`) already
  use the constant.
- 2026-10-29: Test: `control-mcp-server.test.ts` "bounds start_build_pipeline
  maxIterations by the protocol limit" pins the listed schema's
  minimum/maximum to the constant, checks that `MAX + 1` is refused with the
  message and never reaches `start_coordinator_build_pipeline`, and that `MAX`
  is forwarded.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Tool schema uses the protocol constant with a clear refusal message; schema-pinning test added (evidence for the Phase 0 exit criterion: `apps/backend/src/core/control-mcp-server.test.ts`); no other literal limits found. · complete; awaiting PR
- 2026-10-29 · coordinator · Delivered in https://github.com/orkestrator-ai/orkestrator-v2/pull/1436; status done. · None.
