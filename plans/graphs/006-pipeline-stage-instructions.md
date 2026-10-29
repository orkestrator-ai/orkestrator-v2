---
id: 006
title: "Per-stage instructions in the Build Pipeline"
phase: 0
plan: "P0.6"
status: in-progress
depends_on: []
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: ""
updated: 2026-10-29
---

# 006 · Per-stage instructions in the Build Pipeline

- **Plan:** [P0.6 Per-stage instructions in the Build Pipeline](../composable-graphs.md#p06-per-stage-instructions-in-the-build-pipeline)
- **Decisions:** none
- **Depends on:** none
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Users can add their own instructions to each Build Pipeline stage.

## Work

- [x] Add `instructions?: string` to `BuildStepConfig` (at most 16 KiB) with its guard.
- [x] Render it as a framed "Additional instructions from the user" section after the stage's system contract in every stage prompt (`build-pipeline-prompts.ts`). Fix inherits Build's instructions, as it inherits Build's model.
- [x] Store it on the pipeline record so restarts and rewinds reuse it.
- [x] Collapsible text field on each step card in `BuildLaunchDialog.tsx`.
- [x] Feature builds (`CreateFeatureBuildInput`) and the coordinator's `launch_build` accept it.
- [x] Bring `build-pipeline-service-supervisor.ts` under 2,000 lines before adding to it (stage prompts and prompt dispatch moved to collaborators).

## Tests

- [x] Each stage prompt includes the frame when set and nothing when unset.
- [x] Restart and rewind keep the instructions.
- [x] Guards reject over-bound text.
- [x] Coordinator tool round trip and launch dialog component test.

## Done when

- [x] Per-stage instructions round-trip through launch, record, restart and the coordinator tools.
- [ ] Per-stage instructions round-trip through the CLI (no public CLI command launches a build pipeline; see Notes).

## Notes

- 2026-10-29: Shape. `BuildStepConfig.instructions?: string`, at most
  `MAX_BUILD_STEP_INSTRUCTIONS_BYTES` (16,384) UTF-8 bytes. New protocol module
  `@orkestrator/protocol/build-pipeline-stage-instructions`
  (`build-pipeline.ts` is over 2,000 lines): `isBuildStepInstructions` (the
  guard `isBuildStepConfig` calls; blank text passes and carries nothing),
  `buildStepInstructionsBytes`, `normalizeBuildStepInstructions`,
  `buildStepInstructionsSection`, `withBuildStepInstructions(prompt, text)`,
  `pipelineStepInstructions(pipeline, stepKey)`,
  `pipelineReviewerInstructions(pipeline, index)`,
  `pipelineReviewPreparationInstructions(pipeline)`, and the frame constants
  `BUILD_STEP_INSTRUCTIONS_HEADING` ("Additional instructions from the user"),
  `BUILD_STEP_INSTRUCTIONS_PREAMBLE`, `BUILD_STEP_INSTRUCTIONS_FRAME_OPEN`
  (`<user-stage-instructions>`) and `_CLOSE`. Markers inside the text are
  escaped. Not a system-instructions frame: the text is the user's own.
- 2026-10-29: Placement. The section is appended to the stage's own prompt,
  after its contract (for Address after the `fix-result` reporting contract and
  `MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION`; for Verify after
  `VERIFICATION_OUTPUT_CONTRACT`), and before the generic unattended-input
  note `withUnattendedPolicy` adds to every pipeline prompt. Unset steps give
  byte-identical prompts.
- 2026-10-29: Mapping. Build, single Review, Address, Verify, Ship and conflict
  resolution read `steps[stepKeyForSessionPhase(phase)]`, so Fix reads Build's
  (`BuildPipelineStagePrompts.promptFor`). Fan-out reviewer N reads
  `reviewers[N]`, appended after `reviewerPanelSection` so the shared prefix is
  unchanged (005's lens should go between the panel section and this frame).
  The dedicated package preparation (`startReviewPackagePreparation`) and the
  fan-out consolidation read `reviewPreparation`. Decision: without a
  preparation step those turns borrow Address's model but not Address's
  instructions. Single-reviewer inline preparation is part of the Build/Fix
  turn and uses Build's.
- 2026-10-29: Record. `normalizeSteps` / `normalizeReviewers` keep the trimmed
  text and drop blank text. Every stage prompt is rebuilt from the record, so
  restart, rewind, retry, a fresh panel and a backend restart reuse it. Resume,
  result reminders and schema repairs continue a session that already holds the
  opening prompt and do not repeat it. Feature builds: `withVerifyFromAddress`
  copies Address's model to an unpinned Verify, not its instructions.
  Downgrade: older backends ignore the field (the guard does not reject unknown
  keys), so no compatibility path is needed.
- 2026-10-29: Supervisor split. `build-pipeline-service-supervisor.ts` was 2,270
  lines; `promptFor` moved to `BuildPipelineStagePrompts`
  (`build-pipeline-stage-prompts.ts`, exports `StagePrompt`) and
  `dispatchPending` with its dispatch window and resend proof to
  `BuildPipelinePromptDispatch` (`build-pipeline-prompt-dispatch.ts`, also
  exports `readsReviewPackage`, `readOnlyReviewSendOptions`). The supervisor
  keeps delegating `promptFor` / `dispatchPending` methods; it is now about
  1,900 lines.
- 2026-10-29: Coordinator. `start_build_pipeline` steps and
  `reviewPreparation` use `buildStepOverrideSchema` (agent optional,
  `instructions` refined by the byte guard); reviewer rows keep
  `buildStepSchema` plus `instructions`. A step naming only instructions keeps
  its saved selection (`buildPipelineInputWithDefaults`: pipeline agent for
  build, saved row otherwise, saved preparation model or Address's for
  `reviewPreparation`). The result's `selection` reports `instructionsBytes`
  instead of echoing the text.
- 2026-10-29: Launcher. `BuildStepInstructionsField.tsx`: collapsed "*Step*
  instructions" disclosure per card, byte counter, invalid over the bound,
  Start build disabled while any field is over. `BuildLaunchStepSelection`
  gains `instructions`. Instructions are per launch: saved build defaults are
  action defaults (models only), so nothing is persisted as a default. The
  feature-build form in the create-environment dialog has no field; its
  `CreateFeatureBuildInput` accepts the text from any caller.
- 2026-10-29: CLI. No public CLI command or public-API action launches a build
  pipeline (`review launch` is Multi Review), so there is no CLI path to accept
  the field. Adding `build launch` is new public surface (action, input schema,
  operation ledger, docs); it needs its own item. The coordinator's node path
  (`start_controller_build_pipeline`) is covered by the same defaults layering.
- 2026-10-29: Tests. Protocol `build-pipeline-stage-instructions.test.ts`;
  backend `build-pipeline-stage-instructions.test.ts` (every stage end to end,
  unset run, trimmed record, over-bound start, Verify restart and Build rewind,
  fan-out reviewers, consolidation and preparation across a service restart),
  `feature-build.test.ts`, `coordinator-launch-defaults.test.ts`,
  `control-mcp-server.test.ts`; web `BuildLaunchDialog.test.tsx`.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Per-step instructions guarded, stored, framed in every stage prompt, launched from the dialog, feature builds and the coordinator; supervisor split under 2,000 lines; docs updated. · CLI box open: no CLI build launch exists (needs its own item).
