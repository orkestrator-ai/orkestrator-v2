---
id: 006
title: "Per-stage instructions in the Build Pipeline"
phase: 0
plan: "P0.6"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
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

- [ ] Add `instructions?: string` to `BuildStepConfig` (at most 16 KiB) with its guard.
- [ ] Render it as a framed "Additional instructions from the user" section after the stage's system contract in every stage prompt (`build-pipeline-prompts.ts`). Fix inherits Build's instructions, as it inherits Build's model.
- [ ] Store it on the pipeline record so restarts and rewinds reuse it.
- [ ] Collapsible text field on each step card in `BuildLaunchDialog.tsx`.
- [ ] Feature builds (`CreateFeatureBuildInput`) and the coordinator's `launch_build` accept it.

## Tests

- [ ] Each stage prompt includes the frame when set and nothing when unset.
- [ ] Restart and rewind keep the instructions.
- [ ] Guards reject over-bound text.

## Done when

- [ ] Per-stage instructions round-trip through launch, record, restart, the coordinator tools and the CLI.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
