---
id: 001
title: "Pipeline reviewers run read-only, with a generic git guard"
phase: 0
plan: "P0.1"
status: done
depends_on: []
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1436"
updated: 2026-10-29
---

# 001 · Pipeline reviewers run read-only, with a generic git guard

- **Plan:** [P0.1 Pipeline reviewers run read-only, with a generic git guard](../composable-graphs.md#p01-pipeline-reviewers-run-read-only-with-a-generic-git-guard)
- **Decisions:** none (report §2.7, finding 1)
- **Depends on:** none
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Build Pipeline reviewers get the same read-only treatment as Multi Review reviewers, and a git guard backs it up on every provider. Today the launcher claims a Git check for Review that does not exist.

## Work

- [x] Set `reviewerMode: "plan"` on the Build Pipeline fan-out host when a review package exists (`build-pipeline-review-fanout.ts`; host field at `review-fanout.ts:534`).
- [x] Create and prompt the single-review session with `readOnly: true` when a package exists (`startStage` for `review` in `build-pipeline-service-supervisor.ts`).
- [x] Generalise the Verify baseline in `build-pipeline-validation-worktree.ts` into a read-only guard: capture HEAD and the git-visible paths before dispatch, check them at submit time and again when the result is consumed.
- [x] Apply the guard to pipeline review, pipeline consolidation and Verify.
- [x] Change `WorkflowResultService.setAcceptanceCheck` from one check per kind to a list per kind. Each check skips attempts it does not own.
- [x] Correct the launcher note in `BuildLaunchDialog.tsx:571-574` so it describes what is enforced.

## Tests

- [x] Pipeline single-review and fan-out tests assert that `mode: "plan"` and `readOnly: true` reach `createSession` and `send`.
- [x] A reviewer that commits is refused at submit time and can repair within its turn.
- [x] Two acceptance checks registered for one kind both run, and each ignores attempts it does not own.

## Done when

- [x] Pipeline reviewers are read-only on every provider that supports it, and the guard refuses a committing reviewer.
- [x] The launcher note matches what is enforced.
- [x] `docs/architecture/build-pipeline-view.md` and `review-preparation.md` describe the new behaviour.

## Notes

- 2026-10-29: **Guard module.** `apps/backend/src/core/workspace-read-only-guard.ts`
  is provider- and workflow-neutral. It observes the environment only through
  `get_environment_uncommitted_paths`, so local worktrees and containers behave
  the same. API:
  - `type WorkspaceSnapshotProbe = (environmentId) => Promise<ReviewWorktreeSnapshot>`;
    `commandWorkspaceProbe(invoke, attempts?)` builds the default one
    (`probeReviewWorktree`, bounded immediate retries, unretryable codes not retried).
  - `class WorkspaceReadOnlyGuard(probe)`:
    `capture(environmentId, subject) → { baseline: WorkspaceGitBaseline, snapshot }`,
    throws `WorkspaceBaselineUnavailableError` (fail closed before dispatch;
    also when the uncommitted set exceeds the persisted bound);
    `compare(environmentId, baseline | null) → WorkspaceChange` (no probe without a baseline);
    `refusal(environmentId, baseline | null, subject) → WorkflowResultError | null` (submit time);
    `certify(environmentId, baseline | null, subject, { repairableOnly? })` throws
    `WorkspaceReadOnlyViolationError` (`.change`, `.subject`) on consumption.
  - `subject: ReadOnlyGuardSubject = { stage, activity }` words the errors
    ("Review cannot be certified because review changed the environment HEAD").
  - `WorkspaceChange` kinds: `unchanged`, `unrecorded`, `unknown`, `head`,
    `added`, `removed`. Pure helpers: `compareWorkspace`,
    `readOnlyViolationMessage`, `readOnlyViolationRefusal`,
    `workspaceBaselineFromSnapshot`. Refusal code is `worktree_changed`,
    `nextAction: "correct"`.
  - `readOnlyAcceptanceCheck(guard, resolve)` returns a
    `WorkflowResultAcceptanceCheck`; `resolve(attempt)` returns
    `{ environmentId, baseline, subject }` for an attempt the owner is waiting
    on, else null (skip). Item 209 registers one per graph node kind it guards.
- 2026-10-29: **Persisted shape.** New browser-safe protocol module
  `@orkestrator/protocol/workspace-guard`: `WorkspaceGitBaseline
  { head, paths, capturedAt }`, `isWorkspaceGitBaseline`, bounds
  `WORKSPACE_GIT_BASELINE_MAX_PATHS` (10,000) and
  `WORKSPACE_GIT_BASELINE_MAX_PATH_CHARS` (4,096). `ReviewFanoutState` gained
  optional `workspaceBaseline` (pipeline panels only). Single Review and
  Verify sessions keep the existing `validation*AtStart` fields, read and
  written by `build-pipeline-validation-worktree.ts`
  (`sessionWorkspaceBaseline`, `sessionWorkspaceBaselineFields`).
- 2026-10-29: **Acceptance checks are a list.** `WorkflowResultService.setAcceptanceCheck`
  is replaced by `addAcceptanceCheck(kind, check): () => void` (returns an
  unregister function). Checks run in registration order, the first refusal
  wins, a throwing check is skipped without hiding another owner's refusal,
  and every check must return null for attempts it does not own. Item 103's
  registry can hold `acceptanceChecks[]` per kind on top of this.
- 2026-10-29: **Pipeline wiring.** `build-pipeline-read-only-guard.ts`
  (`BuildPipelineReadOnlyGuard`, on `BuildPipelineSupervisor.readOnly`)
  registers one check for `review-report`, `consolidated-review` and
  `verification-result`; it owns an attempt only when the pipeline is in
  `reviewing`/`verifying` and the key is the current single session's, a
  panel reviewer's or the consolidation's. Consumption: `finishReview` and
  `finishVerification` certify the session; the panel certifies whenever a
  reviewer newly completes (and when the runner reports `ready`) and again
  before accepting the consolidated report. The supervisor's
  `verificationResultRefusal` and `reviewWorktreeSnapshot` are gone.
- 2026-10-29: **Modes.** A review with a package runs as a Multi Review
  reviewer: `mode: "plan"`, `readOnly: true` and `reviewerSession: true` on
  creation, and `mode: "plan"`, `readOnly: true` (plus `reviewShellPolicy` for
  OpenCode) on every send of that session, including `dispatchPending`
  redispatches, repairs, reminders and user messages. Fan-out host:
  `reviewerMode: pipeline.reviewPackage ? "plan" : "build"`. Addition beyond
  the item text: the pipeline consolidation session (already `mode: "plan"`)
  now also sends `readOnly: true`, matching Multi Review's read-only
  consolidation turn.
- 2026-10-29: **Legacy.** Review sessions and panel passes recorded before the
  guard have no baseline and are not certified (an upgrade must not fail a
  review in flight). Verify without a baseline still fails as before.
- 2026-10-29: **Scope stated in the launcher.** The guard cannot see an edit to
  a path that was already uncommitted (the path set is unchanged), so the
  Review/Verify note now says so, alongside ignored files, `.git` and paths
  outside the worktree.
- 2026-10-29: **Tests.** `workspace-read-only-guard.test.ts`,
  `packages/protocol/src/workspace-guard.test.ts`, `review-fanout.test.ts`
  (protocol), `workflow-result-service.test.ts` (two checks per kind,
  ownership, unregister, throwing check), `build-pipeline-service-helpers.test.ts`
  (single review: baseline, plan/read-only, commit and stray path fail, submit
  refusal then repair, fail-closed capture, legacy review),
  `build-pipeline-review-fanout.test.ts` (plan/read-only on every reviewer and
  consolidation create/send, HEAD move fails the pass, probe failure fails
  closed, baseline capture failure before dispatch, consolidation HEAD move,
  reviewer and consolidator submit refusal then repair),
  `build-pipeline-steps.test.ts` (per-step modes). Two fan-out tests that
  pinned the old behaviour ("continues … when the live worktree HEAD moves",
  "does not probe the live worktree after the package is prepared") now assert
  the guard. Enforcement on real providers is the existing Multi Review
  `readOnly` path; live conformance runs are item 209's (todo 0031).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Generic read-only Git guard, pipeline reviewers and consolidation read-only, guard on Review/consolidation/Verify, acceptance checks per kind as a list, launcher note and docs (evidence for the Phase 0 exit criterion: `build-pipeline-review-fanout.test.ts`, `build-pipeline-service-helpers.test.ts`). · complete; awaiting PR
- 2026-10-29 · coordinator · Delivered in https://github.com/orkestrator-ai/orkestrator-v2/pull/1436; status done. · None.
