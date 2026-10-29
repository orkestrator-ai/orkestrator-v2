---
id: 007
title: "CLI build pipeline launch"
phase: 0
plan: "P0.6"
status: in-progress
depends_on: [006]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: ""
updated: 2026-10-29
---

# 007 · CLI build pipeline launch

- **Plan:** [P0.6 Per-stage instructions in the Build Pipeline](../composable-graphs.md#p06-per-stage-instructions-in-the-build-pipeline) (its CLI round trip, a Phase 0 exit criterion)
- **Decisions:** none
- **Depends on:** [006](006-pipeline-stage-instructions.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A script can launch, read and cancel a Build Pipeline through the public
`orkestrator` CLI, with per-step models, per-step instructions and reviewer
lenses, so per-stage instructions round-trip through the CLI as the Phase 0
exit criterion asks. Item 006 found no public action or CLI command that
launches a build pipeline.

## Work

- [ ] Public actions `build.launch`, `build.list`, `build.get` and `build.cancel` in the protocol catalogue (`public-api.ts`), their input contracts (`public-api-inputs.ts`) and CLI table (`public-api-cli.ts`).
- [ ] Backend handlers (`apps/backend/src/core/public-api/actions-builds.ts`): `build.launch` launches a Kanban ticket's build, as the Build button does, through the coordinator's path (`buildPipelineInputWithDefaults` with the saved defaults, `isStartBuildPipelineInput`, `BuildPipelineService.start`), in a new environment (`type`, optional base) or an existing one; admission before any side effect; content-free receipts and summaries.
- [ ] The same guards as the coordinator's `start_build_pipeline`: `MAX_BUILD_PIPELINE_ITERATIONS`, 006's instructions bound and 005's lens bounds, refused before admission.
- [ ] Restart recovery: a launch or cancel interrupted by a backend restart settles from the pipeline record, never by launching again.
- [ ] CLI commands `build launch|list|get|cancel` with `--step`, `--instructions`, `--instructions-file`, `--reviewer`, `--focus`, `--focus-file` and `--max-iterations`.
- [ ] Docs: `public-cli.md` command table and notes, `build-pipeline-view.md`, the CLI README and the public skill.

## Tests

- [ ] Public-API action tests: admission, replay, request conflict, guards before admission, content-free receipts and summaries, cancel, restart recovery.
- [ ] CLI command tests: the input each flag sends, JSON output and exit codes, refusals before anything is sent.
- [ ] Round trip: per-step instructions and lenses launched with the CLI land on the pipeline record and survive a backend restart.

## Done when

- [ ] Per-stage instructions and lenses round-trip through the CLI: launch, record and restart.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · coordinator · Created to close 006's open CLI box and the Phase 0 exit criterion's CLI half. · Implement.
