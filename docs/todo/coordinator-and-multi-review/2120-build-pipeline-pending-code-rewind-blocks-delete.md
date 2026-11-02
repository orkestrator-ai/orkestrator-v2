# A pending code rewind blocks deleting its pipeline

## Task analysis

Analysed 2026-11-01 against `main` at `93b99bfb`; rechecked 2026-11-02
against `main` at `38d55ee1` (still true: `remove` still cancelled through
`mutate`, and the new service test failed there with the same reason).

### Tasks

1. **Let a pipeline with an unfinishable pending code rewind be deleted**. Status: done (2026-11-02; live container run not done).

### 1. Deleting a pipeline whose reset cannot finish

**Problem.** After a confirmed code rewind, the pipeline's phase is the
restarted step's (active), so `remove` (`delete_build_pipeline`) calls
`cancel` first, and `cancel` goes through `BuildPipelineContext.mutate`, which
calls `finishPendingCodeRewind` before anything else. While the reset cannot
run, every one of those refuses with "The code rewind to <commit> has not
finished, so this build cannot continue yet. …".

- A container that is stopped or paused recovers on its own: start it and the
  supervisor's next pass finishes the reset.
- A worktree that changed underneath (the container's workspace lost and
  recreated, or the branch moved by hand) never recovers: `resetWorktreeToCommit`
  refuses ("The branch moved since the rewind was previewed"), so the pipeline
  can only be cleared by deleting its environment
  (`deleteBuildPipelinesByEnvironment` deletes the records directly).

**Context.** `remove` in `build-pipeline-service-lifecycle.ts`;
`finishPendingCodeRewind` and `mutate` in `build-pipeline-context.ts`; the
supervisor's retry in `build-pipeline-service-supervisor.ts` (`advance`).
Admission (`codeRewindStateBlocker`) guarantees no session or validation is
running when the intent is journaled, and no agent starts until it finishes.

**Investigation.** Confirmed with the service harness on 2026-11-01: with the
reset's `update-ref` failing as an unavailable container, `service.remove`
rejects with the reason above and the record stays. Not otherwise changed by
0405 task 7, which made the reason readable.

**Decisions.**

- **What should delete do?**
  - **Skip `cancel` when the newest rewind's code is pending, inside the
    pipeline lock, and delete the record (recommended).**
    - Pros: nothing to cancel exists (admission required an idle pipeline);
      the user can always get rid of a stuck pipeline; taking the lock keeps
      the supervisor from finishing the reset after the record is gone.
    - Cons: a confirmed reset that never ran is dropped silently with its
      pipeline; needs a lock entry point that does not finish the reset
      first.
  - **Let `cancel` abandon a pending reset (mark the rewind's code as
    abandoned, then cancel as usual).**
    - Pros: also unblocks cancel, not only delete; the record says the
      reset never ran.
    - Cons: a new rewind state the inspector, `forcePushUpstream` and older
      records must handle.
  - **Leave it: deleting the environment clears it.**
    - Pros: no change.
    - Cons: the user must know to do that, and loses the environment.

## Current state

`remove` (`build-pipeline-service-lifecycle.ts`) first reads the record. When
the newest rewind's `code.pending` is set, it takes the pipeline lock through
`BuildPipelineContext.withLock` (a lock entry point that does not finish the
reset; `mutate` now runs on top of it), re-reads the record under the lock and,
if the reset is still pending, deletes the record without calling `cancel`.
If the supervisor finished the reset while delete waited for the lock, delete
falls back to the old path: cancel, then delete. Every other delete is
unchanged. Pause and cancel still refuse with "The code rewind to … has not
finished" while the reset cannot run.

Covered by two tests in `build-pipeline-service-rewind-follow-ups.test.ts`:
"a pipeline whose pending reset can never run can still be deleted" (the branch
moved after admission; fails on `38d55ee1`) and "a delete waits for a reset
already under way, then removes the pipeline as usual".

## Open questions

- Should the "has not finished" reason add "Delete the build to discard the
  reset" when the reset refuses for good (the branch moved)? Not done: it
  changes user-visible text shared by every control and the supervisor log.

## Needs verification

- The same stuck case in a real container: confirm a code rewind, stop the
  container, recreate its workspace (or move the branch), then delete the
  pipeline from the UI. Only the service harness has been run.

## Assumptions and decisions

### Task 1: delete only, pause and cancel still wait

Chose the recommended option: delete skips `cancel` when the newest rewind's
code is pending. The ticket's title also names pause and cancel; the to-do's
decision keeps them waiting, because unblocking them needs a new "abandoned"
rewind state (option 2) that the inspector, `forcePushUpstream` and older
records would have to handle. Pause and cancel on a stuck pipeline therefore
still refuse; the test asserts that. A recoverable stuck pipeline (stopped
container) still finishes on its own once started.

### Task 1: a separate lock entry point instead of a flag on `mutate`

Added `BuildPipelineContext.withLock(pipelineId, work)`, the queueing half of
`mutate`, and rebuilt `mutate` on it. A `skipPendingCodeRewind` flag on
`mutate` would also save the record after the mutation, which a delete does
not want; a raw lock keeps the delete a single storage call while still
waiting behind a supervisor pass that is mid-reset, so the reset can never run
after the record is gone.

### Task 1: re-check under the lock and fall back

The pending check runs once before the lock (so ordinary deletes do not take
the lock at all and behave exactly as before) and again under it. If the reset
finished while delete waited, the pipeline is active again with nothing
pending, so delete cancels it as usual rather than dropping a build that may
be about to start its step.

### Task 1: preserve the Kanban column update after deletion

Chose a best-effort failed/backlog lifecycle update using the deleted snapshot,
under the pipeline lock. Unlike terminal reconciliation, this update never saves
or recreates the pipeline. Failures are logged and do not block deletion. The
alternative of skipping it leaves the ticket in In progress or Review after its
build disappears. Updating before deletion would add a failure point to the
escape path.

Result slots were already closed when the rewind was admitted, and `remove`
clears provider attribution. Completion comments remain unchanged: the failed
Kanban lifecycle event only moves the column. Full terminal reconciliation and
GitHub completion comments save the pipeline, so they remain skipped. Service
regressions cover both ticket columns, unchanged comments and an update failure
that leaves the pipeline deleted.

### Task 1: the confirmed reset is dropped without a trace

The dropped reset leaves the backup ref, if `update-ref` ever ran, and nothing
else; the pipeline record that described it is deleted. That is the con the
to-do accepted. Error text for pause and cancel is unchanged (it does not yet
tell the user that delete is the way out); see Open questions.

### Task 1: the branch's default-suite failures are not caused by this change

The review-preparation `mise run test` at `7414ea213` failed in eleven tests,
none in a build-pipeline owner. Seven terminal link-routing tests
(`terminalPortalStore.test.ts`, `ClaudeTmuxInteractiveTerminal.test.tsx`) fail
identically when run alone on `main` at `38d55ee14`. The other four are known
timing flakes (cases 1314, 0310, 0280/0320, 2409/2411). They passed alone on the
branch, and the keepalive one also failed alone on `main` under the same load.
Recorded in flake case
[2710](../../tests/flaky-tests/aggregate-validation-runs/2710-pending-code-rewind-delete-validation.md);
no unrelated test or code was changed to hide them.
