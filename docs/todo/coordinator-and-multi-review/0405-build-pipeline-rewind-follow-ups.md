# Build pipeline rewind follow-ups

Checked against the branch that made build pipeline restarts rewind
(2026-10-27) and the branch that built the code items below (2026-10-28). The
design is in
[build-pipeline-view.md](../../architecture/build-pipeline-view.md#restarting-a-step).

## Current state

"Restart from here" on any live step rewinds the pipeline to that step's round
and position (`restartLocatedStage` in
`apps/backend/src/core/build-pipeline-service-lifecycle.ts`, rules in
`build-pipeline-rewind.ts`). Later sessions are kept with `supersededBy` and a
bounded `rewinds` history; the graph collapses them into a greyed "Previous
attempt" node (`pipeline-flow.ts`). Restarts work from `failed` and `complete`;
a re-Ship updates the existing PR; a merged PR refuses the restart. Unit and
service tests cover the rewind, the loop continuing to `maxIterations`, fix
feedback per round, terminal restarts, Kanban, idempotency, denied late
submissions, older records and the projection. Added regression coverage exercises
validation restart repeats while pending/running and after controller reload,
validation-only history beside a live reviewer panel, persistent Kanban failures,
earlier Build/Address/conflict restarts, and a multi-reviewer rewind through
replacement consolidation. Closed-PR service integration covers confirmed reopen
and refusal to complete while the PR stays closed. Browser fixtures cover retained
validation actions and panel grouping at both viewport widths across reload.
Live provider/GitHub qualification below remains separate from these controlled fixtures.

Built on 2026-10-28 (items 3 to 6 below):

- **Rewind code to here.** Every supervisor-started stage session records
  `headAtStart`. "Rewind code to here…" reads
  `preview_build_pipeline_code_rewind` (commits dropped, upstream commits a
  force push would remove, the pull request, a `blocked` reason) and the
  confirmed `rewind_build_pipeline_code` keeps the old tip at
  `refs/orkestrator/build-pipeline-rewinds/…`, runs `git reset --hard` to the
  step's start, records `PipelineRewind.code`, and restarts the step. The next
  Ship force-pushes with lease when the upstream had dropped commits.
  `build-pipeline-code-rewind.ts`, `PipelineCodeRewindDialog.tsx`.
- **Address without rerunning Review.** Each accepted consolidated report is
  kept per round in `roundReviewReports` (1 MiB budget, oldest rounds first);
  restarting an earlier round's Address reruns Address alone on it.
- **Package-only restart on the single-review path.** "Prepare package again"
  on the Build or Fix that wrote the plan, or on its Prepare node, sends
  `review-package:<sessionKey>` and prepares the package in a dedicated
  session without rerunning the Build or Fix.
- **Stacked layout.** A phone-width (390 px) browser fixture expands a
  four-step previous attempt and checks every superseded column draws its own
  bypass beside the node, from the step the restart rewound to.

Tests: `build-pipeline-service-rewind-follow-ups.test.ts`,
`build-pipeline-code-rewind.test.ts`, the round-report block of
`build-pipeline-rewind.test.ts`, the Ship prompt case in
`build-pipeline-prompts.test.ts`, `PipelineFlowView.code-rewind.test.tsx`, and
two scenarios in `e2e/PipelineFlow.spec.ts` (`rewound-loop`, `code-rewind`).

## Outstanding work

### Qualification

1. **A real rewind end to end.** On a `dev:test` profile, let a pipeline fail
   its last Verify, restart round 1's Verify, and check the line, the previous
   attempt node and its expansion, the rerun's Fix 2 → Verify 2 rounds, and
   that leaving the tab and returning keeps the selection and expansion.
   While there, restart round 1's Address and check it reruns alone on round
   1's report, and use "Prepare package again" on a single-review Build.
2. **Re-Ship on a real repository.** Restart Verify on a completed pipeline
   with an open PR and confirm the agent pushes to and edits the same PR
   (`gh pr edit`), and reopens a closed one, rather than opening a second.
   Then "Rewind code to here" on the Build of a shipped pipeline: confirm the
   dialog names the pushed commits, the branch is reset with the backup ref
   in place, and the next Ship force-pushes with lease to the same PR.

### Code

None.

## Done

3. **Stacked layout.** Checked in the component browser fixture rather than
   on a live profile, because the stacked column is a pure projection of the
   record (decision 5): `e2e/PipelineFlow.spec.ts` "an expanded previous
   attempt keeps the live line beside every superseded step" passes at 390 px
   (stacked) and 1024 px (graph, one bypass edge over the attempt).
4. **Rewind the code to a step.** Built as described above; decisions 1 to 3.
5. **Address without rerunning Review.** Built; decision 4.
6. **Package-only restart on the single-review path.** Built; decision 6.

## Assumptions and decisions

Decisions made on 2026-10-28 while building items 3 to 6.

1. **What "Rewind code to here" does to the pipeline.** Options: (a) reset the
   worktree only and leave the pipeline where it is; (b) reset the worktree and
   restart the pipeline from that step in one action; (c) reset and pause.
   Chose (b): the action is "Restart from here" plus the reset, through the
   same `restartLocatedStage` (a `resetCode` hook that runs after admission and
   before any state change). Pros: the code and the pipeline's position always
   agree; idempotency, superseding, Kanban and the merged-PR refusal come for
   free; a refused reset changes nothing. Cons: there is no way to reset code
   without rerunning the step (use git directly for that).
2. **When a reset is allowed, and what it may destroy.** Options: reset any
   time (stopping the running step first), stash uncommitted changes, or
   refuse unless the pipeline is idle and the worktree clean. Chose to refuse:
   the pipeline must be paused, failed or complete with no planned or running
   validation, the worktree must have no uncommitted changes, the target must
   be an ancestor of HEAD, and HEAD must still be the one the confirmed
   preview showed (`expectedHead`). The old tip is kept at a ref under
   `refs/orkestrator/build-pipeline-rewinds/<pipeline>/<rewind>`. Pros:
   nothing can be lost (committed work is recoverable from the ref, and
   uncommitted work is never touched); no race with an agent writing during
   the reset; a branch that moved after the preview is never reset blind.
   Cons: the user must pause first and commit or discard stray changes
   themselves; backup refs accumulate until the environment is removed.
3. **Pushed commits and the open PR.** Options: refuse a rewind past pushed
   commits; revert them with new commits; reset and force-push on the next
   Ship. Chose reset plus force-push with lease: the preview counts
   `target..@{upstream}` and says the next Ship force-pushes, the rewind
   records `upstream` and `upstreamCommitsDropped`, and `forcePushUpstream`
   tells every Ship until a live Ship completes after the rewind to use
   `git push --force-with-lease` (never plain `--force`, never pulling the
   remote commits back) while still updating or reopening the same PR. Pros:
   works on a shipped pipeline, which is where a code rewind is most useful;
   the lease refuses to overwrite commits someone else pushed; the PR keeps
   its number and history of discussion. Cons: the PR's history is rewritten
   (reviewers see a force push); the rule is derived from the newest 50
   rewinds, so a code rewind that has aged out of `rewinds` no longer tells
   Ship to force-push (see Known limits); the count reads the local
   remote-tracking ref, which may be stale.
4. **Where the per-round report copy lives.** Options: stop discarding the
   session `reviewReport` copies; keep a pipeline-level list keyed by round;
   store copies outside the hot record. Chose a pipeline-level
   `roundReviewReports` list (one consolidated report per round, naming the
   session that filed it) with a 1 MiB serialized budget (oldest rounds give
   way first, an oversized report is not copied), valid only while its session
   is the newest live review-phase session of its round. Pros: Address reruns
   alone without bringing back a full reviewer panel per attempt; a retry, a
   retried reviewer or a rewind can never hand Address a stale report; the
   guard bounds the list to `MAX_PIPELINE_ROUND_REVIEW_REPORTS` (11: rounds 0
   to the maximum of 10 iterations). Cons: up
   to 1 MiB more in the hot snapshot in the worst case (reports are usually a
   few KB); a rewound Address runs on the current code with its round's
   report but without the round's review package, so its prompt carries no
   recorded validation section (the package describes earlier code and is
   dropped by every cross-round rewind, as for Verify).
5. **How to qualify the stacked layout.** Options: a manual look at a live
   `dev:test` profile on a phone-width window; a deterministic browser check
   in the component fixture. Chose the browser check (Chromium at 390 px and
   1024 px). Pros: repeatable, runs in `mise run test:browser`, asserts the
   geometry (each bypass spans its node and runs past its right edge) rather
   than a screenshot judgement. Cons: fixture data, not a real run; WebKit and
   a physical phone are not covered (the opt-in `ORKESTRATOR_E2E_BROWSER=webkit`
   run was not done).
6. **How to ask for a package-only restart.** Options: a new command; a new
   field on `restart_build_pipeline_step`; a stage-ID form. Chose the stage ID
   `review-package:<sessionKey>` on the existing command, offered on the Build
   or Fix that wrote the plan and on the Prepare node holding its checks.
   Pros: no new command or protocol type; the backend reuses the
   `review-package` restart that already opens a dedicated preparation
   session; a repeat while that preparation is pending or running is a no-op,
   and a session that wrote no plan is refused. Cons: the stage-ID namespace
   now has a prefix form beside `validation:<runId>`.
7. **`headAtStart` probe cost.** Options: probe HEAD for every stage; reuse an
   existing probe only. Chose to reuse Verify's validation baseline and probe
   once (no retries, no fingerprint) for other supervisor-started stages,
   best effort. Fan-out reviewers and consolidation do not record it. Pros: one
   cheap command per stage; a failed probe only hides the action for that
   step. Cons: one extra round trip into the container or worktree per stage
   start.
8. **Git access.** The reset runs through a new `environmentGit` service
   option wired in `index.ts` to the environment's command runner, not a
   backend command, so a renderer cannot reset a branch around the pipeline's
   checks.

## Needs verification

- Items 1 and 2 above: live runs on a `dev:test` profile with real provider
  logins and a real GitHub repository. Not run here: this worker has no
  throwaway provider or GitHub credentials, and must not use the user's.
- `git reset --hard` and `git update-ref` through `docker exec` in a
  containerized environment (the service tests use a fake `environmentGit`;
  the local runner and the container runner are the same ones the existing
  worktree probe uses, but the reset itself has not run in a container).
- The stacked bypass on WebKit and on a physical phone.

## Known limits (by design)

- Rewinds older than the newest 50 drop their record; their sessions stay
  superseded and the attempt node then shows no restart time. A code rewind
  that ages out also stops telling Ship to force-push.
- A same-round restart carries the first fix attempt's unchanged-worktree
  baseline; a rewind from a later round does not.
- Steps recorded before `headAtStart` existed, fan-out reviewers and
  consolidation offer no code rewind.
- Code rewind backup refs are never pruned by the pipeline.
