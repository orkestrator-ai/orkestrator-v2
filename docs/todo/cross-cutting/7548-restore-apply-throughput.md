# Restore apply throughput at bulk sizes

From [todo 7310](https://github.com/orkestrator-ai/orkestrator-v2/blob/b8aa0721b/docs/todo/cross-cutting/7310-bulk-turn-restore-limits.md) task 2 (done and deleted 2026-11-09; its results are in [Change tracking: restore](../../architecture/change-tracking.md#restore)). Undoing a bulk turn now gets a measurement and a checkpoint, but the apply itself takes minutes.

## Task analysis

Analysed 2026-11-09 against `main` at `b8aa0721b`, with 7310's change applied.

### Tasks

1. **Batch the apply's conditional writes**: restore 10,000 files in seconds rather than minutes, without weakening the per-file precondition. Status: open.
2. **Check what the client does while a multi-minute apply runs**: whether the gateway or the dialog gives up before the backend answers. Status: open.
3. **Repeat 7310's measurements on a quieter host and on a live profile**: the bulk restore and end-recovery numbers so far come from a busy host through the service benchmark. Status: open.

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

**Investigation.** Not run. Drive a 10,000-file restore on an isolated `dev:test` profile through the UI and through the gateway, and record when each side answers.

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

**Investigation.** Not run. Repeat `--only=restore-apply --restore-files=10000,20000` (with and without `--restore-cold`) on a quiet host, and once on an isolated `dev:test` profile with the loopback model at a size whose end capture times out, confirming the turn's measurement is superseded by a `later-recovery` one and restores.

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
