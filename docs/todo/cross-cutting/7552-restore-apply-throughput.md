## Task analysis

# Speed up bulk restore apply and qualify client behaviour

Follow-up from todo 7310 bulk restore qualification; measurements are recorded in [Change tracking: restore](../../architecture/change-tracking.md#restore).

Analysed 2026-11-09 against `main` at `b8aa0721b`, with 7310's change applied.

### Tasks

1. **Batch the apply's conditional writes**: restore 10,000 files in seconds rather than minutes, without weakening the per-file precondition. Status: open.
2. **Check what the client does while a multi-minute apply runs**: whether the gateway or the dialog gives up before the backend answers. Status: open.
3. **Repeat 7310's measurements on a quieter host and on a live profile**: the bulk restore and end-recovery numbers so far come from a busy host through the service benchmark. Status: open. The quiet- and busy-host live-profile applies are done (2026-11-10, under 7310); left: the cold-checkpoint benchmark on a quiet host and a live end-capture timeout that recovers.

### 1. Batch the apply's conditional writes

**Problem.** `ChangeRestoreService.apply` (`restore.ts`) handles one group (a file, or both ends of a rename) at a time: a host-worker `describe` of its paths, then one `bun -e` helper process per file through `hostConditionalWrite` (one `docker exec` per file in a container). At a load average of about 59 on 16 cores that cost 39 ms per file: 10,000 files took 6.5 minutes and 20,000 took 14.1 minutes, every file restored. The checkpoint and result captures took about a second of that.

**Context.** The helper (`CONTAINER_RESTORE_HELPER`) pins the worktree root and every ancestor directory, re-checks the destination's content and mode immediately before writing, writes through a temporary sibling and renames. That per-file re-check is what makes a restore safe against a user edit made since the preview, and it must stay per file. Nothing in it needs its own process: the helper could read a stream of actions and answer one result per action.

**Investigation.** Measured with `bun scripts/benchmark-change-tracking.ts --only=restore-apply` (results in [Change tracking: restore](../../architecture/change-tracking.md#restore)). The split between the per-group `describe` and the helper process was not measured; both are per file. A 500-file run at the same load took 43 ms per file, so the cost is linear.

**Decisions.**

- **How should the apply batch its writes?**
  - **One helper process per batch of groups (for example 500), answering one line per action in order, with the same per-action checks (recommended).**
    - Pros: removes the per-file process start on host and container alike; keeps the precondition, root pin and rename unchanged; a crash mid-batch still leaves a per-action record of what completed.
    - Cons: the helper's protocol changes, so the container path needs the same change and a test that a partial batch reports exactly what was written.
  - **Write in the backend process on the host, keeping the helper only for containers.**
    - Pros: no process at all on the host.
    - Cons: two implementations of a security-sensitive check that must stay identical; the helper exists so the root pin runs beside the files.
- **Should the per-group `describe` go?**
  - **Keep it, batched with the writes it guards (recommended).**
    - Pros: a group's other end is still checked before either mutation.
    - Cons: one more batched call per batch.
  - **Drop it and rely on the helper's own check.**
    - Pros: simpler.
    - Cons: a rename's second end would be checked only after the first was written.

### 2. Check what the client does while a multi-minute apply runs

**Problem.** `changes_apply_restore` answers only when every file is written. Whether the browser gateway, the desktop IPC path or the restore dialog has a request timeout shorter than six minutes was not checked.

**Context.** The apply is idempotent by key (`restoreOperationByKey`): a retry with the same key while it runs answers `changes.restore.in-progress`, and one after it finished returns the recorded outcome, so a client that gave up can recover it.

**Investigation.** The gateway side was observed on 2026-11-10 during 7310's live qualification: on an isolated `dev:test` profile at a load average of about 53, a `changes_apply_restore` of 10,000 files sent to `/__orkestrator/invoke` was answered after 304.9 s with the full outcome, and no transport error. The restore dialog and the desktop IPC path were not driven. Drive a 10,000-file restore through the UI and record when it answers.

**Decisions.**

- **If a client side times out first, what then?**
  - **Return the operation id at once and let the client poll the operation (recommended if task 1 does not bring the apply under the timeout).**
    - Pros: no long request; the outcome is already recorded per operation.
    - Cons: a new command and a progress state in the dialog.
  - **Raise the client timeout for this command.**
    - Pros: smallest change.
    - Cons: a user still waits minutes with no progress shown.

### 3. Repeat 7310's measurements on a quieter host and on a live profile

**Problem.** 7310 asked for timings on a quiet and a busy host. Every 2026-11-09 run was at a load average of 48 to 60 on 16 cores, the only state the shared host was in, and through the service benchmark rather than a live profile driving the loopback fake model as 4960 did.

**Context.** The benchmark runs the same service code as the backend on a real repository on disk; it does not include the gateway, the bridge or the renderer. The end-recovery path ran in it only with the finalization deadline shortened to 2 s (`--restore-finalization-ms`), because at 10,000 and 20,000 files the real 30 s end capture published (12.5 s and 18.0 s).

**Investigation.** Done on 2026-11-10 (7310 task 2, results in [Change tracking: restore](../../architecture/change-tracking.md#restore)): 10,000 and 20,000-file applies on an isolated `dev:test` profile with the loopback model, at load averages of 1 to 10 and of 53 to 57 on 16 cores. Every file was restored and every checkpoint published warm in under a second. At a load of 1 to 10 the apply cost 11 to 14 ms per file against 30 ms at 53, so the per-file helper process, not only load, is most of the cost; that answers the decision below.

Not run: the service benchmark's cold checkpoint (`--restore-cold`) on a quiet host, and a live end-capture timeout. On the live profile 20,000 files written at once ended in 1.3 s quiet and 8.1 s busy, well inside the 30 s deadline, so a live timeout needs a larger tree (4960 timed out 60,000 at once on a quieter host) or a busier host. The policy has no override a live profile can set.

**Decisions.**

- **Is a quiet-host run still needed?**
  - **Yes, once, to bound the best case (recommended).**
    - Pros: tells whether 39 ms per file is load or process start.
    - Cons: needs a quiet host.
  - **No: the busy host is the case the deadlines are set for.**
    - Pros: nothing to run.
    - Cons: task 1's gain cannot be stated against a best case.

## Related

- [Change tracking: restore](../../architecture/change-tracking.md#restore) and [turn and thread boundaries](../../architecture/change-tracking.md#turn-and-thread-boundaries).
- [4960-measurement-rows-live-soak.md](4960-measurement-rows-live-soak.md): the preview measurements this follows.

## Assumptions and decisions

### Task 3: qualification ownership

7310 task 2 owned the quiet-host and isolated live-profile applies and recorded them on 2026-11-10; 7310 is retired. This file keeps only what that run did not cover: the quiet-host cold-checkpoint benchmark and a live end-capture timeout that recovers.

### Task 1: Preserve document identity

Restored or added one H1 title and an origin note below the opening Task analysis heading, retaining the required first section and existing task scope.
