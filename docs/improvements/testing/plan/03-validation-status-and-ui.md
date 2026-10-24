# 03 — Present validation outcomes consistently

Status: Not started. Depends on: 01, 02. Finding: T6.

[Plan index](00-index.md) · [Previous](02-source-identity.md) ·
[Next](04-runner-consistency-and-scope.md)

## Outcome

Make the Tests overview, expanded validation view, workflow state, and reviewer
evidence agree. A user should see missing validation or source uncertainty
without opening a collapsed Notes section. Keep individual exit codes and
useful review-on-failure behavior intact.

## Owners

- Discovery: `packages/protocol/src/review-evidence-frames.ts` and backend
  `review-validation-prompts.ts`.
- Execution/projection: `review-validation-worker.ts`,
  `review-validation-service.ts`, `multi-review-service.ts`,
  `looped-review-service.ts`, and `build-pipeline-service-supervisor.ts`.
- Persistence: review/build stores and their existing snapshot normalizers.
- UI: `apps/web/src/components/review/ReviewValidationStatus.tsx`,
  `MultiReviewTab.tsx`, and `components/build-pipeline/BuildChatTab.tsx`.
- Tests: corresponding component, controller, storage, prompt, and protocol
  suites; `e2e/ReviewValidationOutput.spec.ts` and overview fixtures.

## Producer and controller work

- [ ] Ask discovery to map current repository requirements to selected commands
      or explicit omissions using step 01. Preserve fresh discovery, verbatim
      cooperative commands, and the smallest nonoverlapping command set.
- [ ] Do not let discovery turn mandatory instructions into advisory notes.
      Runtime validation checks structure; provenance lets reviewers inspect
      requirement selection. Document that this is not a proof of exhaustive
      interpretation of arbitrary repository prose.
- [ ] Populate `coveredByCommandId` from worker scheduling, not model claims.
      A covering failure cannot satisfy the covered requirement.
- [ ] Persist the normalized assessment on authoritative workflow snapshots
      and carry it into package metadata. Recompute from authoritative inputs
      when reconciling older snapshots; never trust a stale UI-computed flag.
- [ ] Audit manual Multi Review, looped review, build-pipeline review, restart,
      and final verification separately. Do not fix only the build tab.
- [ ] Preserve the ability to run reviewers on failed/incomplete evidence.
      Require any final success claim to distinguish passing commands from
      full validation; do not introduce automatic extra test runs per reviewer.
- [ ] Keep cancellation, stale-worker recovery, and explicit retry controls
      consistent with current lifecycle rules. A status display change must
      not dispatch another command or restart discovery.

## UI behavior

Use the shared assessment helper rather than duplicating result scans.
Display a primary outcome and, when needed, a concise secondary source qualifier.

| Input | Primary text | Additional visible detail |
| --- | --- | --- |
| Waiting for capacity | Queued | Current queue reason and elapsed wait |
| Commands active | Running | Executing count and authoritative elapsed time |
| Empty completed plan | Not validated | Why no checks ran |
| Required command failed | Checks failed | Failed count; output link |
| Required check missing/unavailable | Validation incomplete | Named missing requirement and reason |
| All selected required checks passed | Required checks passed | Number of commands, not invented test-case count |
| Clean observed live worktree | Keep command outcome | Live worktree; source matched at observed boundaries |
| Dirty/changed/unknown source | Keep command outcome | Source changed or source identity unavailable |
| Cancelled | Cancelled | Partial evidence remains inspectable |
| Legacy record | Actual known command outcome | Validation scope/source metadata unavailable |

Do not collapse every advisory note into a warning. An explicit not-applicable
requirement may be neutral if its reason is recorded. Covered skips are neutral
only with verified typed coverage. Generic skipped checks remain visible.

## Rendering tasks

- [ ] Replace `validationOutcome`'s empty-array success fallback.
- [ ] Keep overview icon, accessible label, tab summary, and expanded heading
      synchronized with the same assessment.
- [ ] Put missing required checks and source qualification outside collapsed
      Notes. Keep verbose details, paths, and advisory notes expandable.
- [ ] Explain when a command row represents an aggregate suite. Display
      “commands/checks” until structured test-case counts exist.
- [ ] Preserve current bounded output loading, stale-response suppression,
      clipboard handling, and explicit truncation notices.
- [ ] Keep controls keyboard-accessible and usable at narrow widths. Ensure
      warnings are expressed in text and not only color/icon selection.
- [ ] Check full reload and environment switching. State must come from the
      persisted workflow, not the component that launched validation.

## Acceptance matrix

Test empty-with-limitation, pass-with-required-browser-omission, pass-with-advisory,
all-covered-skips with a real passing coverer, unsupported/generic skip,
dependency failure, cancelled partial run, unknown legacy scope, and tracked
source drift. Assert visible text and roles as well as icon semantics.

Include loading/stale snapshots and result replacement during output loading.
An older response must not restore a passed badge over newer incomplete state.
Retain counts/timing tests, but avoid duplicating private implementation details.

## Verification and rollout

Run protocol outcome tests, backend projection/controller tests, affected store
and component tests, web/backend typechecks, and component-browser fixtures.
Use an isolated real profile to verify one successful and one incomplete run,
switch away, let it settle, return, then reload. Record exact profile and reset
status. Step 07 will automate this with a deterministic workflow fixture.

Ship compatibility readers and authoritative assessments before changing the
UI. Do not wait for optional structured test reports. Historical records remain
usable, but must not receive facts that were never collected.
