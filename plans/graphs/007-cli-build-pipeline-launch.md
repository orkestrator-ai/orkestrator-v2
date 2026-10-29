---
id: 007
title: "CLI build pipeline launch"
phase: 0
plan: "P0.6"
status: done
depends_on: [006]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1436"
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

- [x] Public actions `build.launch`, `build.list`, `build.get` and `build.cancel` in the protocol catalogue (`public-api.ts`), their input contracts (`public-api-inputs.ts`) and CLI table (`public-api-cli.ts`).
- [x] Backend handlers (`apps/backend/src/core/public-api/actions-builds.ts`): `build.launch` launches a Kanban ticket's build, as the Build button does, through the coordinator's path (`buildPipelineInputWithDefaults` with the saved defaults, `isStartBuildPipelineInput`, `BuildPipelineService.start`), in a new environment (`type`, optional base) or an existing one; admission before any side effect; content-free receipts and summaries.
- [x] The same guards as the coordinator's `start_build_pipeline`: `MAX_BUILD_PIPELINE_ITERATIONS`, 006's instructions bound and 005's lens bounds, refused before admission.
- [x] Restart recovery: a launch or cancel interrupted by a backend restart settles from the pipeline record, never by launching again.
- [x] CLI commands `build launch|list|get|cancel` with `--step`, `--instructions`, `--instructions-file`, `--reviewer`, `--focus`, `--focus-file` and `--max-iterations`.
- [x] Docs: `public-cli.md` command table and notes, `build-pipeline-view.md`, the CLI README and the public skill.

## Tests

- [x] Public-API action tests: admission, replay, request conflict, guards before admission, content-free receipts and summaries, cancel, restart recovery.
- [x] CLI command tests: the input each flag sends, JSON output and exit codes, refusals before anything is sent.
- [x] Round trip: per-step instructions and lenses launched with the CLI land on the pipeline record and survive a backend restart.

## Done when

- [x] Per-stage instructions and lenses round-trip through the CLI: launch, record and restart.

## Notes

- 2026-10-29: Started on 006's branch before 006 is `done` on `main`: the
  coordinator created this item to close 006's CLI box and the Phase 0 exit
  criterion's CLI half, and the work needs 006's field, which is on this branch.
- 2026-10-29: Actions (`packages/protocol/src/public-api.ts`, version 1,
  milestone D): `build.launch` (mutation, receipt; effects metadata,
  filesystem, provider-session, external-repository; capability
  `environments.lifecycle`, confirmation `voice` because the last step opens a
  PR), `build.list` and `build.get` (reads, `sessions.read`), `build.cancel`
  (mutation, `sessions.control`, confirmation `never` like `review.cancel`).
  Input contracts in the new module `@orkestrator/protocol/public-api-inputs-build`
  (`BUILD_ACTION_INPUTS`, `PUBLIC_BUILD_STEPS`, and `REVIEW_LENS_INPUT`, now
  shared with `review.launch`'s reviewer rows); `public-api-inputs.ts` was
  1,919 lines, so the build contracts live beside it. Result shapes in
  `public-api-resources.ts`: `PublicBuildStepSummary` (`agent`, `model`,
  `reasoningEffort`, `fastMode`, `instructionsBytes`,
  `lens: {labelBytes, instructionBytes} | null`), `PublicBuildPipelineSummary`,
  `PublicBuildPipelineDetail` (`steps`, `reviewers`, `reviewPreparation`) and
  `PublicBuildPipelineActionResult` (`pipelineId`, `projectId`,
  `environmentId`, `taskId`, `phase`, `reused?`). Control MCP gets
  `build_launch`, `build_list`, `build_get` and `build_cancel` as direct tools
  from the catalogue; no operator tools under coordinator names were added.
- 2026-10-29: Launch input. `projectId`, `ticketId` (a Kanban ticket: the
  Build button's snapshot of title, description, criteria, comments and
  images, `source: kanban`, the same naming prompt), exactly one of `type`
  (`local`/`container`, a new environment; optional `baseBranch` +
  `baseCommit`, validated by `validateCreateEnvironment` as for
  `environment.create` and passed as the delegation base) and `environmentId`
  (an existing worker environment of the project: not the project checkout,
  not being deleted). `agent`, `steps` (keys `PUBLIC_BUILD_STEPS`; agent
  optional, a model needs its agent, an effort its model; `lens` only on
  `review`), `reviewers` (1–32 rows with agent and model, optional `lens` and
  `instructions`), `reviewPreparation` (no lens), `maxIterations`. A free-form
  task (the coordinator's `taskSnapshot`) is not offered: a script creates a
  ticket first with `ticket create`. `steps.review` with `reviewers` is
  refused, because reviewer 1 becomes the review step and the step would be
  dropped silently (the coordinator tool accepts both).
- 2026-10-29: Launch path (`apps/backend/src/core/public-api/actions-builds.ts`).
  `prepare` (before admission) checks the supervisor
  (`capability-unavailable`), project, ticket and environment, then layers the
  request over the saved Build defaults with the coordinator's
  `buildPipelineInputWithDefaults(…, savedLaunchSettings(config, projectId))`
  and checks `isStartBuildPipelineInput`. Guards: `maxIterations` above
  `MAX_BUILD_PIPELINE_ITERATIONS` → `invalid-input` naming the iteration
  limit; instructions over 16 KiB (`isBuildStepInstructions`) →
  `input-too-large`; lens label or instruction out of bounds → `invalid-input`.
  The scope is `project:<id>`, the intent the parsed input. `execute` runs
  `BuildPipelineService.start` under `runWithContinuation` (stage `launching`
  while provisioning outlasts the request); the result stage is
  `build-launch-saved`. `reused` is true when the ticket's active build (same
  admission key) was returned. `resolved` records the content-free admission
  key and task ID.
- 2026-10-29: Recovery (`build-recovery.ts`). After a restart a running
  `build.launch` with a pipeline holding its recorded admission key (active, or
  created after admission) settles `partial` (`partial-failure`, with the
  pipeline's ID); without one it is `interrupted`. A `build.cancel` settles
  `succeeded` when the pipeline is `failed`, else `interrupted`. Nothing is
  re-run. `build.cancel` is refused (`conflict`) once the build is `complete`
  or `failed`; an abort error after the pipeline ended is `partial`.
- 2026-10-29: CLI (`packages/cli/src/client/commands/build.ts`):
  `build launch TICKET --project P (--type local|container [--base-branch B
  --base-commit SHA] | --environment ENV) [--agent A]
  [--step STAGE=AGENT[/MODEL[@EFFORT]]]… [--instructions STAGE=TEXT]…
  [--instructions-file STAGE=PATH]… [--reviewer AGENT=MODEL[@EFFORT]]…
  [--focus N=TEXT]… [--focus-file N=PATH]… [--max-iterations N]`, where STAGE
  is a step or `preparation` and `N=` names a `--reviewer` row (`-` reads
  stdin); `build list --project P`, `build get BUILD`, `build cancel BUILD`.
  `build get` (the task's "status") prints each step with its byte sizes.
  `parseSelection`, `reviewerLenses` and `SELECTION_HELP` are now exported
  from `workflows.ts` and shared. The client refuses malformed flags,
  over-bound text and a missing or double target before sending (exit 2).
- 2026-10-29: Tests. Backend `public-api/public-api-builds.test.ts` over a real
  `BuildPipelineService` (`public-api/build-test-support.ts`,
  `createBuildHarness`): record, replay, conflict, reuse, every guard before
  admission, sizes in `build.get`/`build.list` across a restart and the
  restarted service's Build prompt carrying the text, new-environment mapping
  with a validated and an unpushed base, cancel, and restart recovery of
  launch and cancel. Protocol `public-api-inputs.test.ts` (risk table). CLI
  `packages/cli/tests/build-command.test.ts`: the input each flag sends, stdin,
  19 refusals that send nothing, backend exit classes, list/get/cancel, and the
  round trip through the real backend's `public_action` (launch, replay,
  restart, record, `build get`, prompt, cancel). Not run:
  `mise run test:cli:scenarios` (packaged backends; not cheap here).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · coordinator · Created to close 006's open CLI box and the Phase 0 exit criterion's CLI half. · Implement.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · `build.*` public actions, recovery, `orkestrator build launch|list|get|cancel` with per-step instructions and lenses, CLI round trip through a real backend; docs updated; 006's CLI box and the exit criterion ticked. · complete; awaiting PR
- 2026-10-29 · coordinator · Delivered in https://github.com/orkestrator-ai/orkestrator-v2/pull/1436; status done. · None.
