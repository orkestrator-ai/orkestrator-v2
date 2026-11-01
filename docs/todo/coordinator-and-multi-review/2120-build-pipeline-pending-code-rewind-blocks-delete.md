# A pending code rewind blocks deleting its pipeline

A build pipeline whose "Rewind code to here" was admitted (the reset journaled
with `pending`) but whose Git reset cannot run cannot be paused, cancelled or
deleted until the reset finishes. Found on 2026-11-01 while running
[0405](0405-build-pipeline-rewind-follow-ups.md) task 7 in a real container.

## Task analysis

Analysed 2026-11-01 against `main` at `93b99bfb`.

### Tasks

1. **Let a pipeline with an unfinishable pending code rewind be deleted**. Status: open.

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
