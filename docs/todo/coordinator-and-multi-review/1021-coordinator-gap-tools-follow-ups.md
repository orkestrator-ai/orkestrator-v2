# Coordinator gap tools: live qualification and follow-ups

## Task analysis

Analysed 2026-10-31 against `main` at `931e55417`.

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
5. **Sidebar fork keeps the source's build pipeline**: deleting a user's fork deletes the source worker's pipeline record. Status: open.
6. **PR follow gaps**: a reopened PR, and a PR tab that ends without opening a PR, wake nobody. Status: open.
7. **"Checks failed" counts checks that are not required**: Status: open.
8. **Separate committed and uncommitted diffs in `get_worker_changes`**: Status: open.

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

**Investigation.** Not reproduced; read from the code only.

**Decisions.**

- **Fix the fork, or the delete?**
  - **Make delete remove only pipelines whose `environmentId` is the deleted environment (recommended).**
    - Pros: protects every path that copies the link, not just Fork.
    - Cons: needs a check that nothing relies on deleting by link.
  - **Stop the sidebar fork copying `buildPipelineId`.**
    - Pros: one-line change, matches `fork_worker`.
    - Cons: loses whatever the link shows on a fork today (the pipeline badge).

### 6. PR follow gaps

**Problem.** A closed PR ends its follow, so a reopened PR is not reported. A
PR tab that finishes without opening a PR sends no wake, so the coordinator
waits for a `pr-opened` that never comes.

**Context.** Both are recorded decisions of the build (coordinator.md,
"Status wakes"). Ending the follow on close keeps the sweep's reads bounded.

**Investigation.** Not measured how often either happens.

**Decisions.**

- **Close the PR-tab gap?**
  - **Wake once when the PR tab's turn ends without a `prUrl`, as the Resolve tab's finish does (recommended).**
    - Pros: the coordinator learns the PR attempt failed; reuses the Resolve
      finish detection.
    - Cons: one more tab watch per `create_pr`.
  - **Leave it; the coordinator can schedule a check.**
    - Pros: no code.
    - Cons: contradicts the "you will be woken" text `create_pr` now returns.

### 7. "Checks failed" counts checks that are not required

**Problem.** `pr-checks-failed` fires on any failed check in the monitor's
rollup, which does not say which checks are required, so an optional check
failing wakes the coordinator.

**Context.** `pr-merge-readiness.ts` documents the rollup as a veto only.
`blocked` mergeability was rejected as the signal because it also covers
required reviews.

**Investigation.** The monitor's `gh` query does not fetch required-check
status.

**Decisions.**

- **Fetch required status, or accept it?**
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

**Investigation.** Not needed for the use it was built for (checking work
before review).

**Decisions.**

- **Add them?**
  - **Wait until a coordinator needs them (recommended).**
    - Pros: no new git calls that bypass change tracking's guards.
    - Cons: a reviewer cannot tell committed from uncommitted lines in one
      file.
  - **Add a `scope: "committed" | "uncommitted"` option over new change-tracking comparisons.**
    - Pros: exact.
    - Cons: change-tracking work for a need not yet seen.

## Current state

All eight items from the review are built and pass the deterministic suite.
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

1. Task 5 (fork and pipeline deletion), task 6 (PR-tab finish wake).
   Tasks 7 and 8 are recommended as no-ops for now.

## Related

- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
- [0142-coordinator-product-surfaces.md](0142-coordinator-product-surfaces.md)
- [0395-coordinator-worker-surfaces-follow-ups.md](0395-coordinator-worker-surfaces-follow-ups.md)
- [0740-coordinator-deliver-now-live-qualification.md](0740-coordinator-deliver-now-live-qualification.md)
