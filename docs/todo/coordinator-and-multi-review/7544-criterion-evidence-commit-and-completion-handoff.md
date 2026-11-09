# Criterion evidence on a commit, and a completion handoff

From a reassessment on 2026-11-08 of the product note "Making Coordinator
intuitive and effective" (2026-10-17, written against `4abf26e4`; not in
the repository). Most of that note has since been built: the outcome-first
composer and badge, Build as the default environment, enforced delivery
policies, Open on the prompts banner, Change agent and the readable paused
state. Two of its points are still missing: evidence that says which code it
was judged on, and an ending that tells the user what was delivered.

## Task analysis

Analysed 2026-11-08 against `main` at `02f55ea9b`.

### Tasks

1. **Record the commit each criterion check judged**: Verify's check names the pipeline but not the code. Status: done.
2. **Put per-criterion results in the Build completion notice and in `get_build_pipeline`**: the coordinator is told only "Last verification: pass". Status: done.
3. **Tell the coordinator to close finished work with a handoff**: what was delivered, which criteria passed on which commit, what is open, what the user must do. Status: done (live check outstanding; see Needs verification).

### 1. Record the commit each criterion check judged

**Problem.** A ticket's criterion shows "passed" with evidence, but not on
which commit. Code can change after Verify (Ship's conflict resolution, a
later fix round, a user's own commit, a rebuild of the same ticket), and the
pass still shows as if it described the current code.

**Context.** `recordTicketCriteriaChecks`
(`apps/backend/src/core/build-pipeline-service-recovery.ts`) writes each
check with `status`, `evidence`, `checkedAt`, `source: "verify"` and
`pipelineId`. `AcceptanceCriterionCheck`
(`packages/protocol/src/ticket-sections.ts`) has no commit field. The Verify
session already knows its commit: `validationHeadAtStart` on the
`PipelineSession`, with `validationWorktreeStatusAtStart`, is the baseline
the read-only guard (`build-pipeline-validation-worktree.ts`) holds the
worktree to for the whole turn, so it is the code the verdict describes.

**Investigation.** Confirmed by reading `main` at `02f55ea9b`; nothing was
run. Adding an optional `commit` (40 hex) and `uncommittedChanges: boolean`
to the check is additive: older readers ignore it, and
`isAcceptanceCriterionCheck` needs one optional branch. A check stored before the change has
no commit and must read as "commit not recorded", never as current.

**Decisions.**

- **How should a stale pass be shown?**
  - **Store the commit, and compare it with the build environment's current HEAD when the ticket is read (recommended).** The ticket tile and `get_ticket` say "passed on `abc1234`; the branch has moved since" when they differ.
    - Pros: keeps the evidence and its history; no write when code moves; the comparison is one read the ticket view can do lazily.
    - Cons: needs the environment, which may be deleted; then the tile shows the commit with no comparison.
  - **Clear or downgrade checks when a new commit lands.**
    - Pros: the board never shows an out-of-date pass.
    - Cons: needs a writer on every commit path; destroys the record of what passed, which the handoff in task 3 needs.
- **What if Verify ran on a dirty worktree?**
  - **Record `uncommittedChanges: true` and say so beside the commit (recommended).**
    - Pros: honest about what was judged; costs one flag.
    - Cons: the judged code cannot be recovered exactly from the commit.
  - **Refuse to record checks from a dirty worktree.**
    - Pros: every recorded pass is reproducible.
    - Cons: loses evidence for a normal case (`commit-only` builds can end dirty).

### 2. Put per-criterion results in the Build completion notice and in `get_build_pipeline`

**Problem.** When a Build ends, the coordinator's wake says the task title,
"Last verification: pass" or "fail", and the delivery line. It cannot say
which criteria passed without reading the ticket, and nothing tells it to.

**Context.** `buildPipelineStatus`
(`apps/backend/src/core/coordinator-status-wakes.ts`) builds the `complete`
and failure notices from the snapshot; details are capped at `MAX_DETAILS`
(8) bounded lines. `get_build_pipeline` returns `workflowSummary`
(`control-workflow-summary.ts`), which carries `phase`, `error`, `delivery`
and workers, but neither `verificationResult` nor the criterion results.
The results are on the Verify session (`acceptanceCriteriaResults`) and,
for a Kanban build, on the ticket (`get_ticket`).

**Investigation.** Confirmed by reading `main` at `02f55ea9b`. Criterion
text and evidence are user and agent content: they may go to the
coordinator's mail and tool results, which already carry the ticket, but
never to logs or metrics (AGENTS.md invariant 12).

**Decisions.**

- **How much goes into the notice?**
  - **Counts plus the ids and text of failed or unchecked criteria, within the existing detail cap; full evidence through `get_build_pipeline` (recommended).**
    - Pros: the wake alone is enough to tell the user what failed; stays bounded; the tool read gives the rest without polling.
    - Cons: a long criterion is cut to one bounded line in the notice.
  - **Every criterion with its evidence in the notice.**
    - Pros: no follow-up read.
    - Cons: breaks the detail cap; a large ticket floods the coordinator's turn.
- **Where does `get_build_pipeline` read them?**
  - **From the last Verify session, with the commit from task 1 (recommended).**
    - Pros: works for Linear and GitHub builds, which have no Kanban ticket to read.
    - Cons: a manual tick on the ticket after the build is not shown there.
  - **From the ticket.**
    - Pros: one source the user also sees.
    - Cons: nothing for non-Kanban builds.

### 3. Tell the coordinator to close finished work with a handoff

**Problem.** A finished task ends with whatever the coordinator happens to
write. The user should be able to read one message and know what was
delivered, what was proved and on which commit, what is still open and what
they must do.

**Context.** Coordinator rules are verbatim constants in
`packages/protocol/src/coordinator.ts`, assembled by
`buildCoordinatorContext` (`coordinator-context.ts`), whose size is held by
a test. The status notice body already ends with "Decide whether it needs
anything from you".

**Investigation.** Not started; depends on task 2 for the facts the rule
asks the coordinator to report.

**Decisions.**

- **Prompt rule or UI card?**
  - **A short rule in the context block, applied when a terminal Build or Multi Review wake arrives: Delivered, Criteria (passed on commit), Open findings or failures, Needs you (recommended).**
    - Pros: one sentence; works for every provider and for remote nodes; the facts come from task 2's notice, so the model reports rather than guesses.
    - Cons: depends on the model following it; the context-size test needs its bound checked.
  - **A rendered summary card in the panel, built from the notice.**
    - Pros: exact and uniform.
    - Cons: new UI the user recently chose to keep out of the panel (the Work panel was removed in #1889); duplicates what the coordinator says next.

## Assumptions and decisions

### Task 1: which session's commit, and how a dirty worktree is marked

The check takes `commit` from the Verify session's `validationHeadAtStart`
(lower-cased, 40 or 64 hex) and sets `uncommittedChanges: true` when its
baseline status is `dirty` or it recorded uncommitted paths
(`verifySessionJudgedCode`). A session with no usable HEAD records neither, so
the check reads "commit not recorded". The pipeline inspector's checks
(`pipelineCriteriaView`) carry the same two fields, so both views agree.

### Task 1: stale passes are compared on read, as recommended

The ticket dialog reads the build environment's HEAD lazily
(`useCriteriaEnvironmentHead`, through `get_environment_uncommitted_paths`
without a fingerprint) only when a check names a commit, and `get_ticket` does
the same with a 5-second limit. Neither writes anything. Another node's ticket
read through `nodeId` shows the commit without a comparison, because this
node cannot read that environment.

### Task 1: manual ticks and graph-engine checks carry no commit

"Commit not recorded" is shown only for `source: "verify"` checks; a hand
tick judged no code, so it shows neither. The graph engine's `update-ticket`
system action (`graph-system-ticket.ts`) still records checks without a
commit and so reads "commit not recorded"; adding one needs the graph Verify
node's baseline, which is out of this file's scope.

### Task 2: one report for the notice and the tool, read from the snapshot

`build-pipeline-criteria-report.ts` reduces the newest live Verify session
(the projection `pipelineCriteriaView` already defines) to counts, the judged
commit and each criterion, failed first, text cut to 500 characters and the
list to 48 KiB. A criterion Verify reported nothing for is `not-checked`, never
passed. The wake shows a tally and each failed or not-checked criterion within
the detail cap, keeping the delivery line, and adds criteria to the `failed`
notice too, since a build that fails Verify on its last iteration has the
same facts to report. `get_build_pipeline` returns the report as `criteria`
with `verificationResult`.

### Task 2: `buildPipelineStatus` moved to its own module

`coordinator-status-wakes.ts` was already over 2000 lines. The build reduction
moved to `coordinator-build-pipeline-status.ts`, and the readers both share
(`record`, `text`, `hash`, `stalledSession`, `MAX_DETAILS`) to
`coordinator-status-support.ts`; `coordinator-status-wakes.ts` re-exports
`buildPipelineStatus`, so callers and tests are unchanged.

### Task 3: the handoff rule rides on the terminal wake, not the context block

- **In the context block (the recommendation here).**
  - Pros: a standing rule the model sees every turn.
  - Cons: the block had about 20 characters left under the 9,000-character
    budget `coordinator-context.test.ts` holds; the rule is about 560, so it
    would raise the cost of every coordinator turn, which that test calls a
    decision rather than a chore.
- **As the last line of a terminal build pipeline or Multi Review notice (implemented).**
  - Pros: no per-turn cost; arrives exactly when it applies, beside the facts
    it asks for; still a verbatim constant (`COORDINATOR_HANDOFF_RULE`) and
    works for every provider and remote node, because notices are mail.
  - Cons: a coordinator that ends work without such a wake (a prompt
    environment's delegation wake, say) is not told.
- **A rendered summary card.** Not taken, for the reason given above.

It replaces "Decide whether it needs anything from you; if not, acknowledge
it and finish the turn" on those notices only, since the two contradict.

## Constraints and rationale

- Missing evidence is never a pass. A check without a commit reads as "commit
  not recorded".
- "Ready for your review", "all criteria verified" and "merged" stay distinct
  in every wording.

## Needs verification

- A live Build from a structured ticket whose wake carries the criteria and
  whose coordinator writes the handoff, and the ticket dialog showing "the
  branch has moved since" after a commit lands in the build environment. Batch it with
  [0742](0742-structured-tickets.md) task 4 (live Verify on each provider)
  and [7545](7545-coordinator-routing-live-scenario.md).

## Related

- [0742-structured-tickets.md](0742-structured-tickets.md), criterion checks
  and delivery policies.
- [7545-coordinator-routing-live-scenario.md](7545-coordinator-routing-live-scenario.md)
- [Status wakes](../../architecture/coordinator.md#status-wakes)
