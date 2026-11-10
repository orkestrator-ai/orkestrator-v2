## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, with 4960 task 2's change applied.

### Tasks

1. **Bulk turns whose end capture times out can never be restored**: decide how a turn-end capture past its 30 s deadline still gets a final measurement. Status: done.
2. **Measure restore apply at bulk sizes**: time `changes_apply_restore` at 10,000 and 20,000 files, and check its 10 s checkpoint captures. Status: open.

### 1. Bulk turns whose end capture times out can never be restored

**Problem.** When a turn's end capture runs out of `finalizationDeadlineMs` (30 s), the turn becomes `end-unavailable` with reason `capture-timeout`, and its restore preview answers `changes.restore.no-retained-endpoints`. Nothing captures it again later, so the turn can never be restored. These are exactly the turns that wrote the most files, which are the ones a user most wants to undo.

**Context.** Original investigation before implementation: `TurnBoundaryService.finalizeTurn` (`turn-boundaries.ts`) captures once with `finalizationDeadlineMs`. The only later capture, `settleInterrupted`, runs only for an `interrupted` turn whose writers were unresolved. Provisional captures during the turn use the 10 s `foregroundBoundaryDeadlineMs`. From the code (not measured): `WorktreeChangeOwner.capture` replaces its stat cache only when a capture publishes, so a capture that times out leaves nothing for the next one to reuse, and every retry reads and hashes the same files cold.

**Investigation.** On the 4960 profile (Claude over the loopback fake model, files written by a driver while the turn was held), these end captures timed out:

- 60,000 files written at once on a quieter host. 30,000 written at once published, its end capture taking 11.6 s.
- 30,000, 60,000 and 90,000 files written in 10,000-file chunks 6 s apart, at a load average of 50 to 56 on 18 cores.
- 20,000 (twice) and 30,000 in chunks at a load average of 57 to 63. 20,000 had published at a load of about 55.

Provisional captures at those sizes also failed with `capture-timeout`, so they did not warm the stat cache for the end capture.

**Decisions.**

- **How should a turn whose end capture timed out get a final measurement?**
  - **Retry the end capture in the background, without holding the turn, and append a superseding final measurement as `settleInterrupted` does (recommended).**
    - Pros: the turn ends on time; reuses an existing later-recovery path and its boundary quality; a retry can be given a longer deadline because nothing waits on it.
    - Cons: writes after the turn ended can be absorbed unless the retry is skipped once another turn on the worktree starts, as `settleInterrupted` already does.
  - **Scale `finalizationDeadlineMs` with the start snapshot's file count.**
    - Pros: smallest change, the same shape as the preview fix.
    - Cons: the turn's end, and anything queued behind it, waits longer; a cold capture of 60,000 or more files under load may still miss.
  - **Keep the reads of a capture that timed out so the next capture resumes warm.**
    - Pros: helps provisional and end captures alike.
    - Cons: a stat cache entry must only come from a settled, stable read; keeping a partial capture's entries needs the same epoch and hint checks the publish path has.

### 2. Measure restore apply at bulk sizes

**Problem.** At the original investigation only the preview was measured. `ChangeRestoreService.apply` (`restore.ts`) runs one `bun -e` helper per file through `hostConditionalWrite`, with its own describe per group, and takes a `restore-checkpoint` capture and a `restore-result` capture, originally each with a 10 s deadline (now scaled with the plan, with a finalization floor). If the checkpoint does not publish, the apply refuses with `changes.restore.checkpoint-unavailable` before writing anything.

**Context.** The checkpoint captures the whole worktree just after a bulk turn, which is a cold capture of every file the turn wrote when the turn's end capture was its only earlier publish. Per 4960, a cold capture of 10,000 files can take several seconds on a busy host.

**Investigation.** Busy-host service benchmarks completed at 10,000 and 20,000 files; every file restored, in 6.5 and 14.1 minutes. These are service timings, not end-to-end profile evidence. Quiet-host and isolated live-profile qualification remain open. Reuse the 4960 method: an isolated `dev:test` profile, the loopback fake model, files written while the turn is held, then a preview and `changes_apply_restore` timed end to end, at 10,000 and 20,000 files, on a quiet and a busy host. Record the outcome, how many files were restored, and whether the checkpoint published.

**Decisions.**

- **If the checkpoint capture times out at bulk sizes, what then?**
  - **Give the checkpoint the finalization deadline, or scale it with the plan as the preview does (recommended).**
    - Pros: the checkpoint is what makes an apply recoverable, so it should not be the step that refuses it; the user is already waiting on an explicit action.
    - Cons: a longer wait before the first write.
  - **Keep 10 s and rely on the refusal.**
    - Pros: no change; nothing is written without a checkpoint.
    - Cons: large restores are refused on busy hosts.

## Current state

Background end recovery and plan-scaled restore checkpoint/result deadlines are implemented. Busy-host service measurements are recorded in the architecture guide. Task 2 remains open until the original quiet/busy host and isolated profile evidence is complete.

## Outstanding work

Run 10,000/20,000-file applies on a quiet host and on an isolated live profile; record outcome, restored-file count, checkpoint publication and end-to-end timings. This shared node has only supplied busy-host service measurements; do not relabel those as live-profile qualification.

## Assumptions and decisions

### Task 2: retain the original qualification

Keep task 2 open here; 7548 owns throughput improvements and client-timeout investigation. Moving the missing evidence to a new ticket would lose the original acceptance requirement.

## Related

- [7548-restore-apply-throughput.md](7548-restore-apply-throughput.md): throughput and client timeout follow-up.
- [Change tracking](../../architecture/change-tracking.md#restore): service benchmark evidence.
