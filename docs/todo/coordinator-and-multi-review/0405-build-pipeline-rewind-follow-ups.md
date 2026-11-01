# Build pipeline rewind follow-ups

Checked against the branch that made build pipeline restarts rewind
(2026-10-27), the branch that built the code items below (2026-10-28) and the
branch that ran the code rewind in a real container (2026-11-01). The
design is in
[build-pipeline-view.md](../../architecture/build-pipeline-view.md#restarting-a-step).

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`.

Items 3 to 6 were built or checked on 2026-10-28 (#1376, `077da798`); they are
listed as done and covered by "Assumptions and decisions" below. Item 7 was
run against a real container on 2026-11-01 (rechecked against `main` at
`93b99bfb`) and is done. What is left
is live qualification: two runs that need provider logins (and, for item 2, a
GitHub repository), and the WebKit check of item 8. Since #1376 the Git side
moved to `workspace-code-rewind.ts`, shared with graph runs' code rewinds
(#1436), the reset became a journaled intent finished under the environment's
exclusive mutation fence, and worktree reads retry once without fsmonitor
(#1460); none of that changes what items 1, 2 and 8 must show. #1393
(`f4e14254`) only rewrote the Verify prompt.

### Tasks

1. **A real rewind end to end**: restart round 1's Verify after the last Verify failed, then Address alone and "Prepare package again", on a `dev:test` profile. Status: open (needs a live provider).
2. **Re-Ship and code rewind on a real repository**: the same PR is pushed to, edited and reopened; "Rewind code to here" on a shipped Build force-pushes with lease. Status: open (needs a live provider and a GitHub repository).
3. **Stacked layout**: every superseded column draws its own bypass at phone width. Status: done.
4. **Rewind the code to a step**: "Rewind code to here…" with preview, backup ref and reset. Status: done.
5. **Address without rerunning Review**: per-round report copies. Status: done.
6. **Package-only restart on the single-review path**: "Prepare package again". Status: done.
7. **Code rewind in a container environment**: `git update-ref` and `git reset --hard` through `docker exec`. Status: done.
8. **Stacked bypass on WebKit and a physical phone**. Status: open.

### 1. A real rewind end to end

**Problem.** Restarts that rewind to a step's round have only unit, service and fixture evidence, and they are on for every pipeline.

**Context.** `restartLocatedStage` (`apps/backend/src/core/build-pipeline-service-lifecycle.ts:1176`) applies the rules in `apps/backend/src/core/build-pipeline-rewind.ts` (`supersedeSessionsFrom` at `:68`, `recordRewind` at `:94`, the round-report helpers `pruneRoundReviewReports`, `retainRoundReviewReport` and `roundReviewReport` at `:179`, `:196`, `:228`). The graph collapses superseded sessions into a "Previous attempt" node (`apps/web/src/components/build-pipeline/pipeline-flow.ts`).

**Investigation.** The description still holds. The fixture scenarios `rewound-loop` and `code-rewind` (`e2e/PipelineFlow.spec.ts:340`, `:379`) and the service tests listed under Current state cover the same steps against fake providers. The live run adds real provider sessions being superseded mid-pipeline, real result slots being closed, and the supervisor picking the restart up from `failed`.

**Decisions.**

- **Which providers run it?**
  - **Cursor for every stage and a two-reviewer panel of Cursor and Pi (recommended).** The user approved the saved Cursor key (as `CURSOR_API_KEY`) and a copied Pi login for disposable `dev:test` profiles on 2026-09-27; reset the profile afterwards.
    - Pros: no interactive login; covers fan-out, consolidation and Address.
    - Cons: does not cover Claude or Codex sessions being superseded.
  - **Claude and Codex after `mise run dev:login`.**
    - Pros: the two most used providers.
    - Cons: the user must log the profile in.
- **One run or separate runs?**
  - **One pipeline, shared with item 1 of [0315](0315-build-pipeline-flow-graph.md) (recommended).** Let it fail its last Verify (a failing test the ticket names, `maxIterations` of 2 or more), then restart round 1's Verify, then round 1's Address. Use a second, single-review pipeline for "Prepare package again".
    - Pros: one fan-out run covers both files' end-to-end checks.
    - Cons: a long run; a fault part-way blocks both.
  - **Separate runs per check.**
    - Pros: each failure is easy to attribute.
    - Cons: three or more full pipelines.
- **What counts as a pass?** The line, the previous-attempt node and its expansion, the rerun's Fix 2 → Verify 2 rounds, and the kept selection and expansion after leaving the tab, as the item lists; the restarted Address runs without a Review session; "Prepare package again" opens a preparation session and leaves the Build's turn live.

### 2. Re-Ship and code rewind on a real repository

**Problem.** The re-Ship and force-push paths have only service and fixture evidence, and they write to a real remote and PR.

**Context.** The Ship prompt tells the agent the existing PR (`existingPullRequestUrl`) and, after a code rewind that dropped pushed commits, to push with `--force-with-lease` (`apps/backend/src/core/build-pipeline-prompts.ts:730-745`; the supervisor sets both at `build-pipeline-service-supervisor.ts:2213-2219`). `forcePushUpstream` (`apps/backend/src/core/build-pipeline-code-rewind.ts:205`) derives the rule from the newest code rewind. The reset is `resetWorktreeToCommit` (`build-pipeline-code-rewind.ts:161-199`).

**Investigation.** The description still holds. Whether `gh pr edit` and `gh pr reopen` are used, and whether the lease push targets the same branch, depends on the agent following the prompt, which only a live run shows.

**Decisions.**

- **Which repository and GitHub credentials?**
  - **A throwaway private repository under the user's account, with a token scoped to it (recommended).**
    - Pros: force pushes and reopened PRs touch nothing that matters; `gh pr edit` and `reopen` run for real.
    - Cons: the user must create the repository and token; this worker must not use the user's own GitHub login.
  - **The Orkestrator repository on a scratch branch.**
    - Pros: no setup.
    - Cons: stray PRs and force pushes on the real project.
  - **A local bare remote.**
    - Pros: no GitHub at all.
    - Cons: no PR, so the PR half is not tested.
- **What counts as a pass?** After restarting Verify on a completed pipeline, the same PR number gets the new commits and an edited description; a PR closed by hand beforehand is reopened. After "Rewind code to here" on the Build, the dialog names the pushed commits, `refs/orkestrator/build-pipeline-rewinds/<pipeline>/<rewind>` holds the old tip, and the next Ship's push is `--force-with-lease` to the same PR.

### 3. Stacked layout

**Problem.** Every superseded column in the stacked (phone-width) layout must draw its own bypass beside the node.

**Context.** Decision 5 below.

**Investigation.** Done. `e2e/PipelineFlow.spec.ts:340` ("an expanded previous attempt keeps the live line beside every superseded step") runs in the `mobile-chromium` (390 px) and `desktop-chromium` (1024 px) projects (`e2e/playwright.config.ts:41-49`).

**Decisions.** None; done. WebKit and a physical phone are task 8.

### 4. Rewind the code to a step

**Problem.** There was no way to reset the branch to where a step started.

**Context.** Decisions 1 to 3, 7 and 8 below.

**Investigation.** Done in #1376. `headAtStart` on `PipelineSession` (`packages/protocol/src/build-pipeline.ts:822`), recorded at `build-pipeline-service-supervisor.ts:1492`; the commands `preview_build_pipeline_code_rewind` and `rewind_build_pipeline_code` (`apps/backend/src/core/commands-registry-build.ts:89`, `:96`); the backup ref (`build-pipeline-code-rewind.ts:63-70`); the `environmentGit` option (`apps/backend/src/core/index.ts:1046`); the dialog `PipelineCodeRewindDialog.tsx`.

**Decisions.** None; done.

### 5. Address without rerunning Review

**Problem.** Restarting an earlier round's Address reran Review, because only the newest report was kept.

**Context.** Decision 4 below.

**Investigation.** Done in #1376. `roundReviewReports` with `MAX_PIPELINE_ROUND_REVIEW_REPORT_BYTES = 1024 * 1024` and `MAX_PIPELINE_ROUND_REVIEW_REPORTS = 11` (`packages/protocol/src/build-pipeline.ts:293-295`); helpers in `build-pipeline-rewind.ts:179`, `:196` and `:228`; tests in the "per-round review report copies" block of `build-pipeline-rewind.test.ts:235`.

**Decisions.** None; done.

### 6. Package-only restart on the single-review path

**Problem.** On the single-review path, preparing the package again meant rerunning the Build or Fix that wrote the plan.

**Context.** Decision 6 below.

**Investigation.** Done in #1376. `pipelinePackageRestartStageId` (`apps/web/src/components/build-pipeline/pipeline-flow.ts:294-313`) offers `review-package:<sessionKey>` on the Build or Fix that wrote the plan and on its Prepare node.

**Decisions.** None; done.

### 7. Code rewind in a container environment

**Problem.** The reset had only run against a fake `environmentGit` and on a local worktree, never inside a container.

**Context.** `createPipelineEnvironmentGit` (`apps/backend/src/core/commands-review.ts`) uses `createEnvironmentCommandRunner`, which for a container runs `docker exec -w /workspace <container> git …`. The Git steps are in `workspace-code-rewind.ts` (`inspectCodeRewind`, `resetWorktreeToCommit`); the journaled reset is finished by `finishPendingCodeRewind` (`build-pipeline-context.ts`), which the supervisor retries every pass (`build-pipeline-service-supervisor.ts`, `advance`). The worktree probe behind `headAtStart` and the preview is `get_environment_uncommitted_paths` (`commands-registry-terminal.ts`), the same runner.

**Investigation.** Done on 2026-11-01. `apps/backend/tests/build-pipeline-code-rewind-docker.test.ts` boots the development image's real entrypoint (full network, labelled, private owner) on this machine's Docker and drives the service harness on fake providers, so no provider turn is taken. Git goes through the production `createPipelineEnvironmentGit` and a real `EnvironmentMutationFence`; the harness's probe answers are filled by running the `get_environment_uncommitted_paths` script in the container. Three cases, all passing:

- The happy path: the Build "agent" commits twice and pushes the first. The preview lists both commits and `origin/<branch>` with one dropped pushed commit; an untracked file blocks the preview and the rewind; after the confirmed rewind, in the container, `git rev-parse HEAD` equals the Build's `headAtStart`, the backup ref resolves to the old tip, the branch is still checked out, `git status` is clean, and the pipeline restarted from the Build on the rewound code. A repeat is a no-op, a retried reset proves the backup instead of moving anything, and the next Ship is told `--force-with-lease`.
- A paused container: the rewind is refused and nothing changes.
- A container paused just as the journaled reset writes the backup ref: nothing starts on the old code, and the reset finishes, and the Build starts on the rewound code, once the container answers.

`update-ref <ref> <head> ""` (the empty old value) passes through `docker exec` intact, and the reset also works with no Git identity configured (checked by hand in a throwaway container). The run found three faults, all in how failures read, none in the reset:

1. A paused, stopped or removed container surfaced Docker's daemon text, naming the container ID ("Error response from daemon: Container <id> is paused, unpause the container before exec"), as the rewind's refusal.
2. The same text came back from every action on the pipeline (pause, cancel, restart) while a journaled reset waited for the container, with nothing saying a rewind was outstanding; and the supervisor logged a warning every 1.5 s for as long as the container stayed down.
3. Where a Git failure is read as an answer, an unreachable container would be read wrongly: as "the commit this step started from is no longer in the repository", as "no upstream" (the next Ship would then push without lease), or as "no backup yet". A retried reset whose backup ref was missing showed Git's `fatal: ambiguous argument` text.

Fixed: `createPipelineEnvironmentGit` reads the container's state (`docker inspect`) after a failed, untimed-out command in a container environment and throws `EnvironmentUnavailableError` ("The environment's container is paused. Unpause it, then try again.", "…is not running. Start the environment, then try again.", "…could not be found…") instead of Docker's text; a running container's failure is passed on unchanged. `workspace-code-rewind.ts` lets that error through wherever it treated a Git failure as an answer, and says "The pending rewind's backup ref is missing." `finishPendingCodeRewind` prefixes "The code rewind to <commit> has not finished, so this build cannot continue yet." The supervisor logs each pending-rewind failure reason once per pipeline. Regression tests: "a container that cannot run Git is never read as a Git answer" (`build-pipeline-code-rewind.test.ts`), "says why a container environment cannot run Git, instead of Docker's text" (`commands-review.test.ts`), and "a journaled reset the container cannot run yet says so, logs once and finishes later" (`build-pipeline-service-rewind-follow-ups.test.ts`); each fails on the code before the fix.

The live test is opt-in like the other live Docker suites (`RUN_LIVE_DOCKER_TESTS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image>`); the Linux Engine qualification workflow now runs it, and `docs/development/container-qualification.md` lists it.

**Decisions.** Decisions 9 to 11 below. Deleting a pipeline whose journaled
reset cannot finish is refused too; that is
[2120](2120-build-pipeline-pending-code-rewind-blocks-delete.md).

### 8. Stacked bypass on WebKit and a physical phone

**Problem.** The stacked layout was checked only in Chromium.

**Context.** Decision 5 below. The browser config accepts `ORKESTRATOR_E2E_BROWSER=webkit` as an opt-in qualification engine and notes WebKit has no `moveBefore` (`e2e/playwright.config.ts:8-15`).

**Investigation.** Not run. The phone and desktop projects keep their names whatever engine runs them.

**Decisions.**

- **Which check counts?**
  - **Run `ORKESTRATOR_E2E_BROWSER=webkit bunx playwright test --config e2e/playwright.config.ts e2e/PipelineFlow.spec.ts` and require the stacked-bypass test to pass in both projects (recommended).**
    - Pros: repeatable; Safari's engine at 390 px; no device needed.
    - Cons: not a real phone (touch scrolling, safe areas).
  - **Also look on a physical phone through the remote gateway.**
    - Pros: the real device.
    - Cons: manual; needs a phone and a reachable profile. Worth doing only if WebKit shows a difference.

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

Run on 2026-11-01 (item 7): "Rewind code to here" in a real container
environment, through `docker exec`, by the opt-in live test
`apps/backend/tests/build-pipeline-code-rewind-docker.test.ts` (fake providers,
the production Git port and fence). An unreachable container is now refused
with a readable reason, and a reset journaled before the container stopped
says it is outstanding, logs once, and finishes when the container answers.

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

### Done

3. **Stacked layout.** Checked in the component browser fixture rather than
   on a live profile, because the stacked column is a pure projection of the
   record (decision 5): `e2e/PipelineFlow.spec.ts` "an expanded previous
   attempt keeps the live line beside every superseded step" passes at 390 px
   (stacked) and 1024 px (graph, one bypass edge over the attempt).
4. **Rewind the code to a step.** Built as described above; decisions 1 to 3.
5. **Address without rerunning Review.** Built; decision 4.
6. **Package-only restart on the single-review path.** Built; decision 6.
7. **Code rewind in a container environment.** Run live on this machine's
   Docker with fake providers; three failure-reporting faults fixed with
   regression tests; decisions 9 to 11.

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

## Constraints and rationale

Known limits, by design:

- Rewinds older than the newest 50 drop their record; their sessions stay
  superseded and the attempt node then shows no restart time. A code rewind
  that ages out also stops telling Ship to force-push.
- A same-round restart carries the first fix attempt's unchanged-worktree
  baseline; a rewind from a later round does not.
- Steps recorded before `headAtStart` existed, fan-out reviewers and
  consolidation offer no code rewind.
- Code rewind backup refs are never pruned by the pipeline.

## Needs verification

- Items 1 and 2 above: live runs on a `dev:test` profile with real provider
  logins and a real GitHub repository. Not run here: the worker that built
  items 3 to 6 had no throwaway provider or GitHub credentials, and must not
  use the user's. Since then the user's approval of the saved Cursor key and a
  copied Pi login for disposable `dev:test` profiles (2026-09-27) has been
  noted under task 1; a GitHub repository is still needed for item 2.
- The container run (task 7) used the development image on Docker Engine on
  Linux, on fake providers. Docker Desktop, rootless Docker and the egress
  gateway topology were not run; the Git commands do not depend on the
  network policy, but the qualification workflow's arm64 and amd64 runs are
  the next evidence. A real provider session committing in the container is
  covered by task 1 or 2 if either runs on a container environment.
- The stacked bypass on WebKit and on a physical phone. Task 8.

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

Decisions made on 2026-11-01 while running item 7.

9. **How to verify the container path.** Options: (a) do one "Rewind code to
   here" during the item 1 or item 2 live run on a container environment;
   (b) an opt-in live Docker test calling `resetWorktreeToCommit` alone;
   (c) an opt-in live Docker test driving the service harness (fake
   providers) through the production `createPipelineEnvironmentGit` and
   fence. Chose (c). Pros: repeatable, needs no provider, login or GitHub;
   covers the preview, the refusal, the journaled reset, the restart and the
   lease rule, not only the Git commands; CI runs it on both Linux
   architectures. Cons: the harness answers the worktree probe from its
   controls, so the test fills them by running the probe's own script in the
   container rather than through the backend command; the container runs the
   image's entrypoint, but no workspace setup clone or bridges; a real agent
   committing in the container is still only covered by (a).
10. **How an unreachable container is reported.** Options: (a) leave Docker's
    text; (b) wrap every rewind refusal in a generic "could not be rewound";
    (c) classify in the Git port by reading the container's state after a
    failed command, and let that error through the rewind's "a failure is an
    answer" steps. Chose (c), in `createPipelineEnvironmentGit`, which every
    workflow Git caller (pipelines, graph runs, the workflow result validator)
    shares. Pros: a readable reason that says what to do; no parsing of
    Docker's message (whose wording varies by version); never mistaken for a
    missing commit, a missing upstream or a missing backup. Cons: one extra
    `docker inspect` per failed command in a container environment (none on
    success or timeout); a container that stops between the failed command
    and the inspect is still reported as Git's own failure.
11. **A journaled reset while the container is down.** Options: (a) keep
    blocking every action until the reset finishes, saying why; (b) let
    pause and cancel through without the reset; (c) abandon the intent after
    some time. Chose (a), as before, with the reason stated and the
    supervisor's warning logged once per reason instead of every 1.5 s.
    Pros: nothing can run on the old code after the user confirmed the
    rewind; recovery is automatic once the container is started. Cons: the
    pipeline cannot be paused, cancelled or deleted until then (deletion
    cancels an active pipeline first); a container whose workspace was lost,
    not just stopped, leaves the reset refused for good ("the branch moved"),
    and only deleting the environment clears it. Recorded as
    [2120](2120-build-pipeline-pending-code-rewind-blocks-delete.md).

## Related

- [build-pipeline-view.md](../../architecture/build-pipeline-view.md#restarting-a-step): the design
- [0315-build-pipeline-flow-graph.md](0315-build-pipeline-flow-graph.md): the flow graph's own live qualification
- [2120-build-pipeline-pending-code-rewind-blocks-delete.md](2120-build-pipeline-pending-code-rewind-blocks-delete.md): a reset that cannot finish blocks deleting its pipeline
