# Coordinator gap tools: live qualification and follow-ups

## Task analysis

Analysed 2026-10-31 against `main` at `931e55417`. Tasks 5 to 8 rechecked and
worked on 2026-11-01 against `main` at `93b99bfba`: all three code problems were
still present.

A review of what coordinators could not do (2026-10-30) led to ten new
Control MCP tools and one new status-wake resource, built on branch
`coordinator-functionality-review-2fe4f885fcb5-r1`:

- `resolve_conflicts`;
- `stop_worker_turn`;
- PR conflicts, mergeability, checks and ready-to-merge on `get_environment`
  and `list_environments`, plus `pull-request` status wakes;
- `get_worker_changes`;
- `fork_worker`;
- `pause_schedule`, `resume_schedule` and `update_schedule`;
- `list_worker_commands` and `run_worker_command`;
- `answer_worker_question`, which only creates a request that the user
  approves.

[`coordinator.md`](../../architecture/coordinator.md) describes each one. Every
tool has unit, service and fake-node tests, and none has run on a real stack.
This file holds that qualification and the gaps the build left.

### Tasks

1. **Live `gap-tools` scenario**: each new tool called once by a live main coordinator on a real stack. Status: open (needs a live provider).
2. **Live PR follow against GitHub**: one PR followed through opened, conflicts, resolve, checks failed, ready and merged. Status: open (needs a GitHub test repository).
3. **Answer relay in the app**: the approval dialog, an edited answer and a real worker resuming. Status: open.
4. **Remote-node paths live**: the new tools' `nodeId` paths over a real node link. Status: open (needs two nodes).
5. **Sidebar fork keeps the source's build pipeline**: deleting a user's fork deletes the source worker's pipeline record. Status: done (2026-11-01).
6. **PR follow gaps**: PR-tab failure and remote Merge and Cleanup wakes are done; reopened PRs remain outside a finished follow. Status: decided, keep the terminal-follow policy (2026-11-01); reopen only when a coordinator needs it.
7. **"Checks failed" counts checks that are not required**: Status: done (2026-11-01); live GitHub evidence is part of task 2.
8. **Separate committed and uncommitted diffs in `get_worker_changes`**: Status: done (2026-11-01); live coordinator use is part of task 1.

### 1. Live `gap-tools` scenario

**Problem.** The new tools are offered to every main coordinator by default
and have never been called by a real agent, so a tool description the model
misreads, or a wake that never arrives, would go unnoticed.

**Context.** The opt-in live suite is `mise run test:agent:coordinator`
(`e2e/agent-testing/coordinator-live.spec.ts`), with scenarios `read-only`,
`async`, `family`, `status` and `peer`
([0024](0024-coordinator-live-conformance.md)). The worker-surface tools are
waiting on the same kind of scenario
([0395](0395-coordinator-worker-surfaces-follow-ups.md) task 4).

**Investigation.** Each tool's backend path is covered without a provider:
`coordinator-worker-turns.test.ts`, `coordinator-worker-changes.test.ts`,
`coordinator-fork-worker.test.ts` (slow tier), `coordinator-pr-status.test.ts`,
`coordinator-status-wakes-pr.test.ts`, `worker-question-relay.test.ts` and
`scheduled-jobs/coordinator-schedules.test.ts`. In `coordinator-worker-turns.test.ts`
the scripted provider did not report idle after a stop, so the confirmed-stop
path was exercised by patching that answer.

**Decisions.**

- **One scenario, or one per tool?**
  - **One `gap-tools` scenario that shares a worker (recommended).** Launch one
    worker, then in order: read its changes, fork it, stop a long turn,
    run a local slash command, pause, update and resume a schedule.
    - Pros: one worker boot; matches how 0395's `surfaces` scenario is planned,
      so the two can share fixtures.
    - Cons: an early failure hides the later checks.
  - **A scenario per tool.**
    - Pros: failures are independent.
    - Cons: many minutes of worker boots per run, for checks that do not
      interact.

### 2. Live PR follow against GitHub

**Problem.** The PR wakes are driven by the PR monitor's readings, which the
tests fake. Only GitHub decides when `mergeStateStatus` turns `DIRTY`, a check
rollup fails, or a merge lands.

**Context.** `coordinator-pr-status.ts` reduces an environment's PR health to
one status; `coordinator-status-wakes.ts` sends it under the `pull-request`
association. A Resolve tab's report waits for the
`refresh-pr-after-agent-completion` recheck, for at most 60 s.

**Investigation.** Not run. The timing of the completion-action recheck and of
the merge-and-cleanup path against a real `gh` are unverified.

**Decisions.**

- **Where to run it?**
  - **A disposable repository under the test account, driven by the live suite (recommended).**
    - Pros: real GitHub state changes; nothing touches this repository.
    - Cons: needs a token and a repository set aside for it, which is an
      outward-facing setup the user has to approve.
  - **Replay recorded `gh` answers.**
    - Pros: deterministic and offline.
    - Cons: proves only what was recorded, which is what the unit tests
      already do.

### 3. Answer relay in the app

**Problem.** `WorkerQuestionApprovalDialog.tsx` is covered by Happy DOM
component tests only. No real worker has been answered through it.

**Context.** The dialog opens from `NodeActionRequestsDialog.tsx`. Approval
runs `answer_project_worker_question`, which re-reads the question and answers
only the recorded revision.

**Investigation.** Not run in a browser or the app. Providers ask questions
differently (Claude's AskUserQuestion, Codex and OpenCode question requests),
so the option shapes need checking per provider.

**Decisions.**

- **How to qualify it?**
  - **A `mise run test:browser` spec plus one live run per question-capable provider (recommended).**
    - Pros: the spec covers layout and editing; the live run covers each
      provider's question shape.
    - Cons: the live part needs every provider signed in.
  - **Live runs only.**
    - Pros: one pass covers both.
    - Cons: layout regressions are caught only when someone runs the live suite.

### 4. Remote-node paths live

**Problem.** Every new worker tool takes `nodeId`, through new node-link-only
controller commands. The remote tests use a simulated node transport.

**Context.** Controller commands: `resolve_controller_conflicts`,
`stop_controller_worker_turn`, `list_controller_worker_commands`,
`run_controller_worker_command`, `get_controller_worker_changes`,
`fork_controller_environment`, `answer_controller_worker_question`. See
[command-nodes.md](../../architecture/command-nodes.md).

**Investigation.** In `coordinator-worker-turns-remote.test.ts` the leaf's
record of where a worker reports was stubbed. An older leaf without relayed PR
health never reports "ready" or check counts.

**Decisions.**

- **Batch with the other node qualification?**
  - **Run with 0395's remote surfaces on the same two-node setup (recommended).**
    - Pros: one setup for every coordinator `nodeId` path.
    - Cons: waits on that setup.
  - **A separate run now.**
    - Pros: earlier evidence.
    - Cons: a second two-node setup.

### 5. Sidebar fork keeps the source's build pipeline

**Problem.** The sidebar's **Fork** copies `buildPipelineId`. Deleting an
environment deletes the pipeline it links to (`deleteBuildPipelinesByEnvironment`),
and the supervisor finds a pipeline's environment by that link
(`findLinkedEnvironment`), so deleting a user's fork can delete the source
worker's pipeline record.

**Context.** Found while building `fork_worker`, which drops the link on
coordinator forks (`forkEnvironmentRecord` with `keepBuildPipeline: false`).
`create_pr` already treats a fork as not owning the pipeline
(`coordinator-pr.ts`).

**Investigation.** Still true on 2026-11-01: `delete_environment` passed the
environment's `buildPipelineId` to `deleteBuildPipelinesByEnvironment`, which
removed the linked record and its transcripts whoever owned it. Reproduced by a
storage test before the fix. The link-only branch exists for one case: a new
pipeline has a blank `environmentId` until `create_environment` links it. No
other path relies on deleting by link.

**Done.** `deleteBuildPipelinesByEnvironment` follows the link only when the
linked pipeline is unowned (blank `environmentId`) or owned by the environment
being deleted; a pipeline owned by another environment keeps its record and
transcripts. Tests: `commands-environment-cleanup.test.ts` ("deleting a
sidebar fork keeps the source's pipeline"), `storage-build-pipelines.test.ts`
and `storage-build-pipeline-transcripts.test.ts`. The sidebar fork still copies
`buildPipelineId`.

**Decisions.**

- **Fix the fork, or the delete?** Chose the recommended delete fix.
  - **Make delete remove only pipelines whose `environmentId` is the deleted environment (recommended).**
    - Pros: protects every path that copies the link, not just Fork.
    - Cons: needs a check that nothing relies on deleting by link.
  - **Stop the sidebar fork copying `buildPipelineId`.**
    - Pros: one-line change, matches `fork_worker`.
    - Cons: loses whatever the link shows on a fork today (the pipeline badge).

### 6. PR follow gaps

**Problem.** A closed PR ends its follow, so a reopened PR is not reported.
The PR-tab failure and remote Merge and Cleanup gaps were repaired on
2026-10-31.

**Context.** Ending the follow on close keeps the sweep's reads bounded.
Publication follows now persist the launched tab and report `pr-not-created`
once when it ends without a URL. The leaf retains bounded terminal PR
readings before environment deletion; remote reconciliation reads them after
missed events and restarts.

**Investigation.** Regression tests cover PR-tab idle and disappearance,
remote merge followed by deletion before reconciliation, restart deduplication,
and launch retries after the PR URL appears or conflicts clear. Live GitHub
and two-node qualification remain tasks 2 and 4.

**Recommendation (2026-11-01).** Keep the terminal-follow policy. A reopen is
rare, the user who reopens it is present, and a coordinator that needs to know
can start a new follow (`get_environment` shows the PR open again). Retaining
closed follows would poll every finished PR for the life of the association,
and the remote path would need tombstones that never expire. Revisit only if a
coordinator workflow is seen to lose a reopened PR.

**Decisions.**

- **Follow reopened PRs?**
  - **Keep the current terminal-follow policy until needed (recommended).**
    - Pros: bounded reads and no change to the promised terminal behavior.
    - Cons: reopening a closed PR needs a new follow.
  - **Retain closed follows indefinitely.**
    - Pros: reopening could wake the original coordinator.
    - Cons: unbounded remote polling for finished work.

### 7. "Checks failed" counts checks that are not required

**Problem.** `pr-checks-failed` fires on any failed check in the monitor's
rollup, which does not say which checks are required, so an optional check
failing wakes the coordinator.

**Context.** `pr-merge-readiness.ts` documents the rollup as a veto only.
`blocked` mergeability was rejected as the signal because it also covers
required reviews.

**Investigation.** Still true on 2026-11-01: `prCondition` returned
`checks-failed` for any failure in the rollup. `gh pr view --json
statusCheckRollup` has no required flag; GraphQL's
`isRequired(pullRequestNumber:)` on `CheckRun` and `StatusContext` has. `gh pr
checks --required` was rejected: it has no head guard, and it treats a PR with
no required checks as an error, which the monitor could not tell from a failed
read.

**Done.** The ticket asked for required checks only, so this departs from the
recommended "accept it" option, keeping its notice as the fallback:

- `PrCheckSummary` gains an optional `requiredFailed`
  (`packages/protocol/src/pr-monitor.ts`), relayed in node summaries and the
  `environment-pr-health` key.
- The monitor asks `pr-required-checks.ts`'s GraphQL query only when the
  rollup shows a failing check, inside the same `pr-check-rollup` span, and
  caches the answer per PR, head commit and failing-check set (30 minutes; a
  failed lookup retries after 5). A PR whose optional check keeps failing is
  asked once per push, not on every 20 s poll, so the "heavier query on every
  poll" con no longer applies.
- `pr-checks-failed` fires only when a required check fails. A PR whose only
  failures are optional stays quiet (`pr-open`, no wake) and is still not ready
  to merge, the shimmer's rule. `prChecks` keeps `failed` (every failing
  check) and adds `requiredFailed`.
- **Fallback:** when GitHub does not say which checks are required (a token
  that cannot read it, more than 100 checks, the head moved between the two
  reads, a non-github.com host, or an older node that does not relay the
  count), `requiredFailed` is null, every failing check counts, and the notice
  says "A check failed (it may not be required)".

The sidebar's red check badge still counts every failing check, as GitHub's own
page does.

**Decisions.**

- **Fetch required status, or accept it?** Chose to fetch, only on failure and
  cached, with the recommended notice as the fallback.
  - **Accept it, and say "a check failed (it may not be required)" in the notice (recommended).**
    - Pros: no extra GitHub query per poll.
    - Cons: an occasional needless wake.
  - **Fetch `isRequired` per check.**
    - Pros: exact.
    - Cons: a heavier query on every poll for every PR.

### 8. Separate committed and uncommitted diffs in `get_worker_changes`

**Problem.** The diff is base to working tree, with files marked
`uncommitted` where they also have uncommitted changes. A file changed both
ways shows one combined diff.

**Context.** Change tracking has no diff bodies for commits-only or
uncommitted-only comparisons; using it keeps its guards against git filter,
textconv and external-diff programs.

**Investigation.** Still true on 2026-11-01. Change tracking's live detail
(`resolveLiveDetail`) reads both sides as raw bytes (`git cat-file blob` and
the owner's file read) and diffs them in-process, so it never runs a filter,
textconv or external-diff program. It only accepted `environment-net` rows.

**Done.** The ticket asked for separate diffs, so this departs from the
recommended "wait" option, over change tracking as that option required:

- A new Git scope, `committed-net` (`git-scopes.ts`): the base commit the
  environment's own measurement uses, to `HEAD`, measured with the same
  guarded `git diff --no-ext-diff --no-textconv` as the other Git scopes. It
  is unavailable (`baseline-unavailable`) until `environment-net` has an
  immutable base. `uncommitted-net` and `committed-net` split `environment-net`
  at `HEAD`.
- `resolveLiveDetail` also serves `uncommitted-net` rows (HEAD blob to working
  tree) and `committed-net` rows (base blob to HEAD blob). Rows Git measures
  through a filter driver are refused with `git-filter-unsupported`.
- `get_worker_changes` adds a `committed` file list, marks `sinceBase` files
  `committed: true` as well as `uncommitted: true`, and takes
  `diffScope: "sinceBase" | "committed" | "uncommitted" | "split"`.
  `committed` and `uncommitted` answer in `committedDiffs` and
  `uncommittedDiffs`; `split` returns both, halving the byte budget.
- **Older callers:** without `diffScope` the answer is unchanged (`diffs`,
  base to working tree); the new `committed` list and flags are additive. An
  older node that ignores `diffScope` answers with the combined diff, and the
  caller adds `diffScopeUnsupported` to say so.

Tests: `coordinator-worker-changes.integration.test.ts` (real Git: one file
changed in a commit and again uncommitted shows each side's lines apart),
`coordinator-worker-changes.test.ts`, `git-scopes.test.ts` and
`control-mcp-server.test.ts`.

**Decisions.**

- **Add them?** Chose the `scope` option, named `diffScope`, plus `split`.
  - **Wait until a coordinator needs them (recommended).**
    - Pros: no new git calls that bypass change tracking's guards.
    - Cons: a reviewer cannot tell committed from uncommitted lines in one
      file.
  - **Add a `scope: "committed" | "uncommitted"` option over new change-tracking comparisons.**
    - Pros: exact.
    - Cons: change-tracking work for a need not yet seen.

## Current state

On 2026-11-01 tasks 5, 7 and 8 were fixed and task 6 was decided (keep the
terminal-follow policy); see each task. Tasks 1 to 4 need live providers,
GitHub or two nodes and were not run.

All eight items from the review are built. Targeted coordinator regressions,
the storage writer guard, backend and protocol typechecks, scoped formatting
and lint, and the flake-index guard pass.
A post-merge review found five integration bugs: a recurring PR state not
waking again, a merged wake lost on merge and cleanup, a double-reported PR
follow, a follow-filter race, and an account-switch timer that could be made
to fire late. It also found that denied commands wrapped in `invoke_on_node`
were not checked by name. All of these were fixed on the same branch.

## Outstanding work

### Qualification

1. Task 1 (live scenario), task 2 (GitHub), task 3 (dialog and providers),
   task 4 (two nodes).

### Code

None. Task 6 is decided as no change. Tasks 7 and 8 also need live
qualification: the required-checks query against a real repository with branch
protection (task 2) and a coordinator using `diffScope` (task 1).

## Assumptions and decisions

### 2026-11-01: tasks 5 to 8

- **Task 5.** Fixed the delete, the recommended option, rather than the fork,
  so every path that copies `buildPipelineId` is covered and the sidebar fork
  keeps its link. Assumed nothing relies on deleting another environment's
  pipeline by link; the only link-only case left is an unowned pipeline.
- **Task 6.** Recommend and keep the terminal-follow policy (see task 6).
- **Task 7.** The ticket's acceptance asks for required checks only, which
  overrides the file's "accept it" recommendation; its notice is kept as the
  fallback. Assumed `isRequired` is answered by the same `gh` credential the
  monitor already uses; a token that cannot read it falls back. The ready-to-
  merge rule is unchanged, so an optional failure still blocks the shimmer and
  reports `prNotReadyReason: "checks-failing"`.
- **Task 8.** The ticket's acceptance asks for separate diffs, which overrides
  the file's "wait" recommendation. Built on change tracking, as the file's
  other option required, so no new unguarded Git call was added. Assumed a new
  measurement scope is acceptable in the ledger; a backend older than this one
  reading that ledger would not recognise `committed-net` rows (they are
  on-demand and only created by `get_worker_changes`). Each read of a worker's
  changes now runs one more guarded `git diff` pair, and later scans recompute
  `committed-net` like `uncommitted-net` once a coordinator has asked.

### Task 6: completion recovery

Kept the terminal-follow policy for reopened PRs. Persisted the PR publication
tab because a successful launch does not prove a PR was opened. Retained at
most 1,000 terminal PR tombstones on the owning node so recovery also works
when deletion events are missed; an event-only relay would not survive that
loss. Existing action receipts provide bounded durable replay on both nodes.

## Needs verification

The 2026-10-31 review repairs are committed as `a77573f49` and `c4f91b183`.
The latter registers retained terminal PR readings in `StorageFiles`, under
the existing environment mutation lease; its guard and remote recovery tests
pass. The exact required wide commands were rerun:

| Command | Observed result |
| --- | --- |
| `mise run test:full` after the storage registry repair | Completed in 913.8 s including 204.5 s waiting for host admission. Backend: 14,591 passed, 145 skipped, 31 failed, all in unchanged browser preview/rendering owners. Web: 10,963 passed, 10 skipped, zero failed. Root: 3,650 passed, one skipped, one existing DOM-diagnostic assertion failed. Bridges retain the existing ACP child-limit assertion, which also fails alone. The command is non-green. |
| `mise run test:browser` | Runner deadline at 30 minutes: 720 of 1,096 cases scheduled, 101 reported failures. Incomplete; the chained public-site suite did not start. |
| `mise run test:agent:electron` | Two passed, 15 failed, 30 did not run. The same failure set occurred in preparation, including missing X server/display and desktop title expectations. |
| `mise run test:agent:docker` | Four skipped, 14 failed. The required `orkestrator-v2:dev-45b60cc8059b` image and ready fixture profile are unavailable. |

Final full-suite evidence is retained in `/tmp/orkestrator-test-run.UVuLi8/`
and `/tmp/orkestrator-test-run.sFiOj2/`; browser evidence in
`/tmp/orkestrator-test-run.iVjYqA/`, Electron in
`/tmp/orkestrator-test-run.acMWj6/`, Docker in
`/tmp/orkestrator-test-run.ykzZho/`. These failures do not certify the wide
suites. No unrelated assertion, timeout or skip was changed. Live provider,
GitHub and two-node qualification remain tasks 1–4.

## Related

- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
- [0142-coordinator-product-surfaces.md](0142-coordinator-product-surfaces.md)
- [0395-coordinator-worker-surfaces-follow-ups.md](0395-coordinator-worker-surfaces-follow-ups.md)
- [0740-coordinator-deliver-now-live-qualification.md](0740-coordinator-deliver-now-live-qualification.md)
