---
id: 004
title: "A typed Address report"
phase: 0
plan: "P0.4"
status: in-progress
depends_on: []
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: ""
updated: 2026-10-29
---

# 004 · A typed Address report

- **Plan:** [P0.4 A typed Address report](../composable-graphs.md#p04-a-typed-address-report)
- **Decisions:** none (report §2.7, finding 4)
- **Depends on:** none
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Address → Verify becomes a typed handoff. Today Verify reads the Address session's last assistant text.

## Work

- [x] Address turns open a `fix-result` result slot (tool or structured transport). The schema exists: `complete`, `summary`, `filesChanged`, `commandsRun`, `notes`, `limitations`.
- [x] The missing-result reminder and stage failure apply to Address as to the other stages.
- [x] `verificationPrompt` renders the accepted result as an evidence frame.
- [x] Keep `latestAddressReport` as the fallback for Address turns started before the upgrade and for providers without a result transport.
- [x] Store the accepted result on the Address session (bounded) so the inspector can show it.

## Tests

- [x] An Address submission reaches the Verify prompt as a framed report.
- [x] A pipeline record from before the upgrade still uses the last assistant text.
- [x] A missing Address result triggers one reminder, then fails the stage.

## Done when

- [x] New runs: Verify reads a typed Address report.
- [x] Old runs stay readable and resumable.
- [x] `build-pipeline-view.md` and `review-preparation.md` describe the handoff.

## Notes

- 2026-10-29: Address is a typed stage. `BuildPipelineContext.workflowResultKind`
  maps `addressing` to `fix-result`; `promptFor("address")` returns
  `REVIEW_FIX_RESULT_JSON_SCHEMA`, so `startStage` opens the slot over
  `tool-v1` (`submit_fix_result`) or `structured-output-v1` as for Review and
  Verify, and `dispatchPending` re-prepares it with that schema. The prompt's
  old "End with a validation report as your final message" became
  `ADDRESS_FIX_RESULT_REPORTING` + `ADDRESS_OUTPUT_CONTRACT`
  (`build-pipeline-prompts.ts`, inside `addressValidationInstruction`).
- 2026-10-29: Session fields (`PipelineSession`, protocol):
  `addressReportKind?: "fix-result"` is the recorded marker set by `startStage`
  on an Address session opened with the slot; `fixResult?: PipelineFixResult`
  is the bounded accepted copy. Both are valid only on `phase: "address"`, and
  `fixResult` only with the marker. Shape and bounds live in the new protocol
  module `@orkestrator/protocol/build-pipeline-address-report`
  (`PIPELINE_ADDRESS_REPORT_KIND`, `PipelineFixResult`,
  `PIPELINE_FIX_RESULT_LIMITS`, `boundPipelineFixResult`,
  `isPipelineFixResult`); `build-pipeline.ts` is already over 2,000 lines.
  Bounds: summary 4,000 chars; 48 files × 300; 20 checks (failed kept first)
  × 500 + 500; 10 notes and 10 limitations × 600; dropped entries counted in
  `omitted`.
- 2026-10-29: `finishAddress` (`build-pipeline-service-recovery.ts`) reads the
  result, uses `awaitStructuredResult` (one reminder, then "The address stage
  finished without returning its required structured result"), fails a
  contract-rejected structured-output result ("The address stage returned a
  malformed fix result: …"), stores `fixResult`, opens Verify and consumes the
  slot. Decision: `complete: false` does not fail the stage (Multi Review's
  fix step does); Verify judges the round, as it judged a prose report before.
- 2026-10-29: Verify input: `verificationAddressReport` in the new
  `apps/backend/src/core/build-pipeline-address-report.ts` (moved out of the
  supervisor with the old `latestAddressReport`). `verificationPrompt` now takes
  `VerificationAddressReport = { kind: "fix-result"; result } | { kind: "text"; text }`.
  The typed report is framed with `ADDRESS_FIX_RESULT_FRAME_INSTRUCTION` and
  `<address-fix-result-json>` (`review-evidence-frames.ts`). A typed session
  never falls back to text; superseded Address sessions are skipped; a round
  with no Address (clean review) renders "**Address report**: none."
- 2026-10-29: Fallback: an Address session without `addressReportKind`
  (pre-upgrade) advances on idle without a result read, resumes without a slot
  (`resumePromptFor(phase, { addressResult })`, lifecycle `resume`), and Verify
  reads its last assistant text. Counted as compatibility path
  `build-pipeline.address-text-report`, registered in
  `version-compatibility.md`. No shipped provider lacks a result transport
  today (all six have `structured-output-v1`), so that half of the fallback is
  the same marker-less path. Downgrade: older backends ignore the new fields;
  a pending tool-mode Address dispatch fails with "lost its result-slot
  binding".
- 2026-10-29: UI: `PipelineAddressReport.tsx` in the Address node's inspector
  notes (collapsed "Address report · complete|incomplete · N files · M checks
  (K failed)"); `WorkflowResultStatus` now names `fix-result` for Address.
- 2026-10-29: For 006 (per-stage instructions in the same prompts): the Address
  prompt is `prependReviewHandoff(handoff, addressPrompt(report,
  addressValidationInstruction(pkg, target)))`; the reporting contract is the
  last system-frame block before `MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION`.
  The Verify prompt's `addressReportSection` sits between recorded validation
  and the acceptance-criteria section. For 108 (template pinning): the stage →
  kind map is `workflowResultKind` (`building|fixing` → `review-preparation` or
  `validation-plan`, `reviewing` → `review-report`, `addressing` → `fix-result`,
  `verifying` → `verification-result`; fan-out consolidation is
  `consolidated-review`); Ship and conflict resolution still have no result.
- 2026-10-29: Tests: `apps/backend/src/core/build-pipeline-address-report.test.ts`
  (framed handoff end to end in tool mode, reminder delivers/ignores, malformed
  structured-output result, pre-upgrade record uses the text and counts the
  path, clean review has no report, resume prompt, slot schema),
  `build-pipeline-verification-evidence.test.ts` (typed, skipped typed,
  superseded, counter), `build-pipeline-result-reminder.test.ts` (addressing
  binding), `build-pipeline-prompts.test.ts`, `build-pipeline-steps.test.ts`,
  protocol `build-pipeline-address-report.test.ts`, web
  `PipelineFlowView.test.tsx`. Every pipeline fake now answers Address with
  `TEST_FIX_RESULT` (`build-pipeline-test-fixtures.ts`).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Address opens a `fix-result` slot; Verify reads the bounded `fixResult` as an evidence frame; marker-based text fallback counted as a compatibility path; inspector shows the report; docs updated. · complete; awaiting PR
- 2026-10-29 · coordinator · Ticked the Phase 0 exit criterion "Verify reads a typed Address report" in the index, citing this item's tests. · Awaiting PR.
