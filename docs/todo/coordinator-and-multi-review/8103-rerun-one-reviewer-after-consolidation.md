# Rerun one reviewer after consolidation

From to-do 0315 (retired 2026-11-10) task 7
(`git show 76a0bb93a^:docs/todo/coordinator-and-multi-review/0315-build-pipeline-flow-graph.md`).
Once a review pass has consolidated, one reviewer cannot be rerun on its own:
the stage restart reruns the whole panel and Consolidation. On 2026-11-14 the
user (maintainer) chose to build a per-slot rerun.

## Task analysis

Analysed 2026-11-14 against `main` at `066992035`. Nothing has been built.

### Tasks

1. **Per-slot reviewer rerun after consolidation**: rerun one reviewer, keep the other reviewers' reports, supersede Consolidation and everything after it, and re-consolidate. Status: open.
2. **Live check of the rerun**: one build pipeline whose panel has consolidated, rerun one reviewer on a loopback fake model, and check the graph, the reports and the re-consolidation after a reload. Status: open (depends on 1).

### 1. Per-slot reviewer rerun after consolidation

**Problem.** Rerunning one bad reviewer costs the whole panel's time and
tokens, which grows with panel size.

**Context.** `prepareReviewerRetry` throws "The review has been consolidated;
restart the review stage to rerun it" once the pass has a report
(`apps/backend/src/core/build-pipeline-review-fanout.ts`, about line 668;
tested in `build-pipeline-review-fanout-retry.test.ts`). `reviewFanout` is
cleared when the review stage finishes (`packages/protocol/src/build-pipeline.ts`),
so after Address Findings starts there is no live panel to retry in. The
rewind machinery (`restartLocatedStage`, `build-pipeline-service-lifecycle.ts`)
supersedes by round and position, not by panel slot. Since #1354 a restart
from a reviewer or Consolidation reruns the whole pass and keeps the old
reviewers readable as a previous attempt. The public command is
`retry_build_pipeline_reviewer` (`packages/protocol/src/contract/domains/pipelines/commands.ts`).
Behaviour: [build-pipeline-view.md](../../architecture/build-pipeline-view.md).

**Investigation.** Not started. What has to exist: a second supersede rule
beside the round rule (one slot's reviewer, Consolidation and every later
step of the round become a previous attempt; the other slots' reports stay
current); the kept reports must still certify against the pass's
`reviewFanout.workspaceBaseline` and `validationHeadAtStart`; Address
Findings and later steps are invalidated like any rewind; the flow graph
shows the rerun slot and the superseded Consolidation.

**Decisions.**

- **Which state does the rerun read the other reports from?**
  - **The pass's stored reviewer reports, kept with the round, re-attached to
    a new fan-out that holds only the rerun slot as live (recommended).**
    - Pros: no live sessions to keep warm across Address; the stored reports
      are already what Consolidation read.
    - Cons: needs the stored fan-out to be rebuildable after the stage ended.
  - **Keep `reviewFanout` live until the pipeline finishes.**
    - Pros: the retry path works as before consolidation.
    - Cons: every pipeline keeps panel state it rarely needs; changes the
      stage-end contract.
- **Is the rerun allowed while a later step runs?**
  - **No: refuse while any step after Consolidation is running; the user
    stops it first (recommended).**
    - Pros: no race between a running Address and its own supersede.
    - Cons: one more click.
  - **Stop the later step automatically.**
    - Pros: one click.
    - Cons: a destructive side effect from a retry button.

### 2. Live check of the rerun

**Problem.** The supersede rule spans the backend, the projection and the
graph, which unit tests cover only piecewise.

**Context.** `e2e/PipelineFlow.spec.ts` covers the graph against a fixture
backend; a real-stack check runs on a disposable `dev:test` profile with a
loopback fake model.

**Investigation.** Depends on 1.

**Decisions.**

- **Which run proves it?**
  - **A fixture for the projection plus one credential-free real-stack run
    with a fake model, including a reload and an inactive-environment switch
    (recommended).**
    - Pros: no billed turns; proves rehydration.
    - Cons: does not prove a real reviewer's output.
  - **A billed real-provider panel.**
    - Pros: real reviewers.
    - Cons: tokens for what a fake model shows equally well.

## Assumptions and decisions

### Build the per-slot rerun (user decision, 2026-11-14)

The user (maintainer) chose on 2026-11-14 option (b) of 0315 task 7: build a
per-slot rerun that keeps the other reviewers' reports, supersedes
Consolidation and everything after it, and re-consolidates, rather than
keep the refusal and the whole-pass restart.

## Constraints and rationale

- A reviewer turn stays read-only and certified against the pass's
  workspace baseline.
- Unmount is not cancel: the rerun is backend state, and the graph
  rehydrates from it.

## Related

- [build-pipeline-view.md](../../architecture/build-pipeline-view.md)
- To-do 0315 (retired 2026-11-10) task 7: the original analysis.

## Replaces

Nothing; new work from 0315 (retired) task 7.
