---
id: 005
title: "Reviewer lenses"
phase: 0
plan: "P0.5"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
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

- [ ] Add `lens?: { label: string; instruction: string }` to `ReviewerModelSelection` (`packages/protocol/src/review-fanout.ts`), with guards: label at most 64 characters, instruction at most 4 KiB.
- [ ] Render the lens after `reviewerPanelSection` (`multi-review-prompts.ts`) and in the pipeline reviewer prompt, so the shared prefix stays byte-identical.
- [ ] Carry each reviewer's lens label into consolidation evidence (`review-consolidation-evidence.ts`).
- [ ] Add the app setting `reviewLensPresets` (at most 20 presets, same bounds) shipping five presets: Security, Performance, Tests and coverage, API and compatibility, Maintainability.
- [ ] Settings editor beside the Multi Review defaults: edit, delete, reorder, add, restore the shipped five.
- [ ] "Focus" field per reviewer row in `MultiReviewLaunchDialog.tsx` and `BuildLaunchDialog.tsx`: a preset or free text. Launch copies the text into `lens`.
- [ ] Saved Multi Review defaults (`MultiReviewAgentSettings`) keep lenses per position.
- [ ] Coordinator launch tools and CLI `review launch` accept `lens`.

## Tests

- [ ] Prompts for a panel with different lenses share a byte-identical prefix up to the panel section.
- [ ] Guards reject over-bound labels, instructions and preset lists.
- [ ] Consolidation evidence includes lens labels and stays within its budget.
- [ ] Settings round trip, including restoring the shipped presets.
- [ ] Editing or deleting a preset leaves a recorded review unchanged.
- [ ] Coordinator tool and CLI round trip.

## Done when

- [ ] Lenses round-trip through launch, record, restart, the coordinator tools and the CLI.
- [ ] Presets are editable in Settings.
- [ ] Todo [0025](../../docs/todo/coordinator-and-multi-review/0025-multi-review-panel-value.md), which lists lenses as a later decision, says what shipped.

## Notes

- Todo 0025 measures panel value and prompt caching; check its cache findings before changing prompt layout.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
