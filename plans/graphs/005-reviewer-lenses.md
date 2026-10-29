---
id: 005
title: "Reviewer lenses"
phase: 0
plan: "P0.5"
status: in-progress
depends_on: []
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: ""
updated: 2026-10-29
---

# 005 · Reviewer lenses

- **Plan:** [P0.5 Reviewer lenses](../composable-graphs.md#p05-reviewer-lenses)
- **Decisions:** D19
- **Depends on:** none
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Each reviewer in a panel can have a focus instruction (a lens), chosen from presets the user can edit in Settings or typed at launch, without breaking the panel's shared, cacheable prompt prefix.

## Work

- [x] Add `lens?: { label: string; instruction: string }` to `ReviewerModelSelection` (`packages/protocol/src/review-fanout.ts`), with guards: label at most 64 characters, instruction at most 4 KiB.
- [x] Render the lens after `reviewerPanelSection` (`multi-review-prompts.ts`) and in the pipeline reviewer prompt, so the shared prefix stays byte-identical.
- [x] Carry each reviewer's lens label into consolidation evidence (`review-consolidation-evidence.ts`).
- [x] Add the app setting `reviewLensPresets` (at most 20 presets, same bounds) shipping five presets: Security, Performance, Tests and coverage, API and compatibility, Maintainability.
- [x] Settings editor beside the Multi Review defaults: edit, delete, reorder, add, restore the shipped five.
- [x] "Focus" field per reviewer row in `MultiReviewLaunchDialog.tsx` and `BuildLaunchDialog.tsx`: a preset or free text. Launch copies the text into `lens`.
- [x] Saved Multi Review defaults (`MultiReviewAgentSettings`) keep lenses per position.
- [x] Coordinator launch tools and CLI `review launch` accept `lens`.

## Tests

- [x] Prompts for a panel with different lenses share a byte-identical prefix up to the panel section.
- [x] Guards reject over-bound labels, instructions and preset lists.
- [x] Consolidation evidence includes lens labels and stays within its budget.
- [x] Settings round trip, including restoring the shipped presets.
- [x] Editing or deleting a preset leaves a recorded review unchanged.
- [x] Coordinator tool and CLI round trip.

## Done when

- [x] Lenses round-trip through launch, record, restart, the coordinator tools and the CLI.
- [x] Presets are editable in Settings.
- [x] Todo [0025](../../docs/todo/coordinator-and-multi-review/0025-multi-review-panel-value.md), which lists lenses as a later decision, says what shipped.

## Notes

- Todo 0025 measures panel value and prompt caching; check its cache findings before changing prompt layout.
- 2026-10-29: Shapes. New protocol module `@orkestrator/protocol/review-lens`
  (`packages/protocol/src/review-lens.ts`): `ReviewLens { label, instruction }`,
  `ReviewLensPreset extends ReviewLens { id }`, bounds
  `REVIEW_LENS_LABEL_MAX_CHARS` (64 code points, one line, non-blank),
  `REVIEW_LENS_INSTRUCTION_MAX_BYTES` (4,096 UTF-8 bytes, non-blank),
  `REVIEW_LENS_PRESETS_MAX` (20, distinct ids of at most 64 characters);
  guards `isReviewLens`, `isReviewLensPreset`, `isReviewLensPresetList`;
  `normalizeReviewLens` / `reviewLensField` (trim at launch),
  `sanitizeReviewLensPresets` (read path), `resolveReviewLensPresets`
  (absent → shipped), `restoreShippedReviewLensPresets`,
  `isShippedReviewLensPresetList`, `matchingReviewLensPreset`,
  `reviewLensFromText` (first line label, rest instruction; CLI), and the
  prompt section `reviewLensSection` / `withReviewLens` with
  `REVIEW_LENS_HEADING` ("Review focus") and the frame
  `<reviewer-focus>` … `</reviewer-focus>` (markers escaped, framed like 006's
  `<user-stage-instructions>`). `ReviewerModelSelection.lens?: ReviewLens`;
  `BuildStepConfig.lens?: ReviewLens` (kept only on `steps.review` and
  `reviewers`).
- 2026-10-29: Guards. `isReviewerModelSelection` accepts `lens`; the new
  `isReviewStepModelSelection` refuses it and backs
  `isMultiReviewModelSelection` (reviewModel, consolidationModel, fixModel,
  customFixModel, restart and fixLaunch models). Reviewer rows use
  `isMultiReviewReviewerSelection`. `REVIEWER_KEYS` gains `lens`.
- 2026-10-29: Shipped presets (`SHIPPED_REVIEW_LENS_PRESETS`), ids `security`,
  `performance`, `tests-and-coverage`, `api-and-compatibility`,
  `maintainability`. App setting `reviewLensPresets?: ReviewLensPreset[]` in
  config.json `global` (`AppConfig.global`, web `GlobalConfig`): absent means
  the shipped five; a stored list, even empty, is the user's. Text is stored as
  typed (launches trim), so an autosave never rewrites a field mid-edit.
  `ConfigRepository.updateGlobalConfig` refuses an invalid list
  ("Review focus presets must be …"); `normalizePersistedConfig` keeps the
  valid presets of a hand-edited file. Added to
  `INHERITED_GLOBAL_SETTING_KEYS` (a command node passes it to leaves). The
  public CLI `settings` surface covers project and environment scopes only, so
  there is no CLI key for this app setting (documented in public-cli.md).
- 2026-10-29: Prompt placement. `reviewerPanelTail(n, count, lens)`
  (`multi-review-prompts.ts`) = panel section + lens section; the packaged and
  live Multi Review prompts end with it, and the pipeline fan-out prompt is
  `withBuildStepInstructions([discovery, reviewerPanelTail(...)], reviewer
  instructions)`, so the order is discovery, panel, lens, 006's frame. The
  fan-out host's `reviewerPrompt(index, count, reviewer)` now receives the
  reviewer record. A single-reviewer pipeline review renders
  `steps.review.lens` after the discovery contract, before the step's
  instructions (not in the item text; added so a saved Reviewer 1 focus is not
  silently ignored on one-reviewer builds). Todo 0025's finding (Claude caches
  only to a message boundary) means the lens changes nothing Claude can cache
  today; the shared prefix stays byte-identical for providers that cache within
  a message.
- 2026-10-29: Consolidation. `ConsolidationSourceReport.focus` /
  `ConsolidationReviewerEvidence.focus` carry the label (from
  `consolidationReports`); the instruction is not sent. The prompt adds one
  paragraph (`CONSOLIDATION_FOCUS_NOTE`) only when a reviewer has a focus, so a
  lens-free panel's prompt is unchanged. Labels are required content, never
  reduced. Overlap and provenance unchanged.
- 2026-10-29: Records and restarts. Multi Review `start` stores the trimmed lens
  on each reviewer record; `restartReviewer` and `retry` keep it. The pipeline
  stores it on `reviewers` / `steps.review` (`normalizeSteps`,
  `normalizeReviewers`; `normalizeReviewPreparation` drops it) and copies it
  onto each fan-out record in `BuildPipelineReviewFanout.start`, so retries,
  fresh passes, rewinds and backend restarts reuse it.
- 2026-10-29: Saved defaults. `MultiReviewAgentSettings.reviewerLenses?:
  Array<ReviewLens | null>`, one entry per position from Reviewer 1 (so it
  covers `additionalReviewers` positions), normalized by
  `normalizeReviewerLenses`, resolved by `resolveMultiReviewSettings`
  (`reviewerLenses` padded to the count). Read by `ActionBar.view.tsx`
  (button rows), `buildPipelineConfiguredDefaults` (Build defaults) and
  `multiReviewDefaultRows` (coordinator), all from the app tier as the button
  reads reviewer count.
- 2026-10-29: UI. `ReviewLensField.tsx` (Focus select: No focus, presets,
  Custom… with label and instruction, byte counter; `useReviewLensPresets`,
  `reviewLensDraftError`, `launchedReviewLens`), used on Multi Review reviewer
  rows, Build reviewer cards (including the single Review card) and each row of
  the Multi Review defaults. `ReviewLensPresetsEditor.tsx` in Settings → Review
  under the Multi Review defaults: edit, delete, reorder (up/down), add,
  restore. Invalid presets or an incomplete saved focus are save blockers. The
  Multi Review tab shows "Focus: label" on a reviewer tile. Duplicate-row
  warnings treat different lenses as different rows
  (`multiReviewSelectionKey`).
- 2026-10-29: Callers. Coordinator: `reviewLensSchema`,
  `reviewerSelectionSchema` (start_multi_review), `buildReviewerSchema`
  (start_build_pipeline `reviewers`) in `control-mcp-tool-support.ts`, and a
  strict reviewer row in `launch_multi_review`; results report
  `lens: { label, instructionBytes }` (`selectedLens`). Public API:
  `review.launch` reviewers accept `lens` (`public-api-inputs.ts`
  `reviewerSelection`); receipts stay content-free (IDs and states). CLI:
  `orkestrator review launch ENV --reviewer A=M[@E]… --focus N=TEXT
  --focus-file N=PATH` (repeatable; N is the 1-based `--reviewer` row; first
  line label, rest instruction; requires `--reviewer` rows).
- 2026-10-29: Deviation (compatibility). The plan says an older backend ignores
  the field. That holds for Build Pipeline launches (`isBuildStepConfig`
  allows unknown keys), but the Multi Review launch guards already refused
  unknown keys, so an older backend refuses a Multi Review launch whose
  reviewer row carries a lens. Rows without a focus send no `lens` key and
  launch as before; records without lenses read as before. An older backend
  cannot read a Multi Review or fan-out record written with a lens. Recorded in
  review-preparation.md; no code change can fix an already-shipped backend.
- 2026-10-29: Todo 0025 asked that lenses ship only if corpus recall does not
  regress. The deterministic corpus checks hold
  (`multi-review-evaluation.test.ts` "reviewer lenses over the corpus"); a
  live recall run with lensed panels is recorded there as open qualification.
- 2026-10-29: Index. The Phase 0 exit criterion "Lenses and per-stage
  instructions round-trip … the CLI" is split in `000-index.md`: the lenses
  half is ticked; per-stage instructions through the CLI stays open (no CLI
  build launch, 006 Notes), so the parent stays unticked. The docs criterion is
  ticked: the three docs now cover 001–006 (this item added the
  `maxIterations` bound from 002 to coordinator.md, which had no mention of it).
- 2026-10-29: Tests. Protocol `review-lens.test.ts`, `agent-settings.test.ts`;
  backend `multi-review-prompts.test.ts` (byte-identical prefix across a panel
  with different lenses), `review-consolidation-evidence.test.ts`,
  `multi-review-evaluation.test.ts`, `multi-review-service.test.ts` (record,
  dispatch, restart, preset edit and delete leave the record unchanged),
  `build-pipeline-reviewer-lens.test.ts` (fan-out across a backend restart,
  retried reviewer, single reviewer), `coordinator-launch-defaults.test.ts`,
  `control-mcp-server.test.ts` (three tools, bounds, result summaries),
  `storage-config.test.ts` (settings round trip, refusal, restore),
  `public-api/public-api-reviews.test.ts`; CLI
  `packages/cli/tests/node-review-pr-command.test.ts`; web
  `MultiReviewLaunchDialog.test.tsx`, `BuildLaunchDialog.test.tsx`,
  `MultiReviewDefaultsEditor.test.tsx`, `ReviewLensPresetsEditor.test.tsx`,
  `MultiReviewTab.test.tsx`.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Lens field, guards, prompt tail, consolidation focus, `reviewLensPresets` setting and editor, Focus fields, saved per-position lenses, coordinator tools and CLI `--focus`; docs and todo 0025 updated. · complete; awaiting PR
