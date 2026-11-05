# Environment delete follow-ups

## Task analysis

Analysed 2026-11-05 against `main` at `50d4916ca`, with the delete fix on its branch.

### Tasks

1. **Confirm the fix on the machine that reported it**: repeat a Merge and Cleanup on `arktech-mini` with a release containing the fix and read the event-loop log. Status: open.
2. **See a real failed delete in a real window**: drive one actual delete failure through the UI, across a reload. Status: open.
3. **Per-step delete progress**: tell the user which step a slow delete is on. Status: open.
4. **Bound a delete that hangs**: a delete that neither fails nor finishes spins with only its elapsed time. Status: open (depends on 3).
5. **Watch readiness before `fseventsd` delivers**: a watch reports `established` before events are known to flow. Status: open.

### 1. Confirm the fix on the machine that reported it

**Problem.** The 15-minute deletes were seen on `arktech-mini` (macOS 27, 64 GB) with real environments. The fix was measured on another Mac with a fixture.

**Context.** [environment-deletion.md](../../architecture/environment-deletion.md#watches-and-the-event-loop) records the numbers: 18 cores, macOS 26.6.2, 130 idle environments, `fseventsd` at about 100% of a core. The six deletes went from 72.2 s to 15.9 s, with stalls of up to 24.7 s reduced to none over 100 ms.

**Investigation.** Not run there: the work is confined to isolated profiles, and that machine holds the user's real environments. The reported log pattern to compare is `[event-loop] stalled` repeating with `lagMs` of 10,000-30,000.

**Decisions.**

- **How to confirm it?**
  - **Read the production log after the next real Merge and Cleanup on a release with the fix (recommended).**
    - Pros: real load and real worktrees; touches nothing extra.
    - Cons: waits for a release and the user's next batch of merges.
  - **Run the benchmark on that machine with a throwaway profile.**
    - Pros: numbers directly comparable with the table.
    - Cons: adds load to a machine doing real work, and 130 fixture environments cost disk there.

### 2. See a real failed delete in a real window

**Problem.** The failed state has been seen in the real UI only with its record seeded into the renderer's store, and the backend's half only in tests.

**Context.** `commands-environment-cleanup.test.ts` covers the real failure, the recorded reason, restart recovery and the retry. `remote-row-parity.test.tsx` covers the row. In a browser, the Retry button ran a real delete that removed the environment, starting from the seeded state.

**Investigation.** The one throw reachable by ordinary means is a terminal tree that survives a kill, which a normal process cannot do. A restart retries a persisted failure at once, so editing the record does not hold the state either.

**Decisions.**

- **How to stage it?**
  - **Give `dev:test` a fixture terminal whose `terminate()` reports survival (recommended).**
    - Pros: exercises the whole path, including a reload, on demand.
    - Cons: a test-only hook in the terminal layer.
  - **Wait for a natural failure.**
    - Pros: no new code.
    - Cons: may never be observed, and cannot be repeated.

### 3. Per-step delete progress

**Problem.** A slow delete says how long it has run but not what it is doing.

**Context.** The ticket asked for a small change here and a to-do for anything larger. The row shows "Still deleting after N min" from `lifecycleOperationStartedAt`. The ledger already names the steps still pending, in the backend only.

**Investigation.** Nothing sends the current step to clients. It would need a new record field, a summary field for other machines and a row line.

**Decisions.**

- **Where should progress come from?**
  - **Record the current step on the environment record as `deleteEnvironment` reaches it (recommended).**
    - Pros: rehydrates like the rest of the record and reaches other machines through summaries; a few writes per delete.
    - Cons: one more field under the compatibility rules.
  - **Expose the ledger's pending steps.**
    - Pros: no new state.
    - Cons: covers only the steps the ledger tracks, not terminals or records, which is where a delete can wait longest.

### 4. Bound a delete that hangs

**Problem.** A child process or Docker call that never returns leaves a delete spinning with no reason and no retry, because a retry is refused while the delete is running.

**Context.** The failure path covers a delete that throws. The hang was not reproduced; this is a gap in the code rather than an observed failure.

**Investigation.** The steps run through `runEnvironmentCleanupStep`, and no overall deadline wraps `deleteEnvironment`. An abandoned step could still be running when a retry starts, so a deadline has to prove the step stopped.

**Decisions.**

- **What should a hung delete do?**
  - **Add a deadline per external step that fails the delete with a reason (recommended).**
    - Pros: reuses the failure path and its retry; each step can kill its own child.
    - Cons: a deadline has to allow for a genuinely large tree on a slow disk.
  - **Offer a user-driven "give up" after a long wait.**
    - Pros: no timing guess.
    - Cons: needs its own proof that the abandoned work stopped, or it risks two deletes in one worktree.

### 5. Watch readiness before `fseventsd` delivers

**Problem.** `established`, and with it a worktree watcher's `qualified`, means the helper's `fs.watch` call returned, not that events are flowing. On a loaded Mac a change made soon after it can go unreported until the owner's safety scan.

**Context.** `watch-host.ts` sends `ready` right after `fs.watch` returns, while Bun starts its FSEvents stream afterwards on another thread. The in-process `fs.watch` this replaced counted as covered at the same point, so this is not a regression. The owner rescans at `established`, and treats events as hints throughout.

**Investigation.** With `fseventsd` at 100% of a core, five probes (Bun and Node, recursive and not, the temporary directory and the checkout), each writing one new file a second, all received their first event 72 s in, naming the ninth file. Each received 42 to 44 events by 149 s for the 107 files up to the last one named. So files were lost after the stream was running as well as before, which means late registration alone does not explain the loss. How long registration itself took was not measured.

**Decisions.**

- **What should readiness mean?**
  - **Leave it as the call returning, with the safety scan as the backstop (recommended).**
    - Pros: no new moving parts; the backstop is needed anyway, because events are lost even on a running stream.
    - Cons: a change in the gap shows only at the next safety scan.
  - **Have the helper hold `ready` until an event arrives from a private directory it writes to.**
    - Pros: `qualified` then means the stream has delivered something, and a slow host keeps polling for longer.
    - Cons: a temporary directory and repeated writes in the helper; a host that delivers nothing leaves every watch unqualified; a delivered event still does not prove later ones arrive.

## Current state

Directory watches on macOS run in a helper process, the worktree is no longer watched while it is removed, recovery stands aside while a delete runs, and a failed delete shows its reason with a retry.

## Needs verification

Six concurrent `git worktree remove` runs finished within 5 ms of each other before the fix, and six whole deletes within about 65 ms of each other after it, although nothing serializes them. The cause was not established, and it costs no event-loop time.

## Related

- [environment-deletion.md](../../architecture/environment-deletion.md)
- [0735-git-fsmonitor-follow-ups.md](0735-git-fsmonitor-follow-ups.md)
