# Environment delete follow-ups

## Task analysis

Analysed 2026-11-05 against `main` at `50d4916ca`, with the delete fix on its branch.
Re-analysed 2026-11-06 against `main` at `c1724ab74` (the fix merged as #1902); tasks 2-5 done then.
Task 6 done 2026-11-09 against `main` at `c6de4733c`.

### Tasks

1. **Confirm the fix on the machine that reported it**: repeat a Merge and Cleanup on `arktech-mini` with a release containing the fix and read the event-loop log. Status: open.
2. **See a real failed delete in a real window**: drive one actual delete failure through the UI, across a reload. Status: done (2026-11-06).
3. **Per-step delete progress**: tell the user which step a slow delete is on. Status: done (2026-11-06).
4. **Bound a delete that hangs**: a delete that neither fails nor finishes spins with only its elapsed time. Status: done (2026-11-06).
5. **Watch readiness before `fseventsd` delivers**: a watch reports `established` before events are known to flow. Status: done (2026-11-06; decided to leave it, with evidence).
6. **Store cleanup that holds the event loop**: a delete parses every native session and rewrites the whole agent-mail document without yielding. Status: done (2026-11-09).

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

### 6. Store cleanup that holds the event loop

**Problem.** Part of a delete's record cleanup runs on the backend's thread without yielding, and concurrent deletes run theirs as one block. On a heavy store, five deletes at once left a 0.6-1.1 s gap, or 4.4-5.2 s on a heavily loaded host.

**Context.** `scripts/benchmark-delete-store-work.ts` measures it; the workload and numbers are in [environment-deletion.md](../../architecture/environment-deletion.md#the-work-a-delete-does-besides-watches). It is a fraction of a second against the tens of seconds the watch stalls cost, which is why it was not fixed with them.

**Investigation.** Two calls account for nearly all of it. `deleteNativeAgentSessionsByEnvironment` (`storage-native.ts`) calls `loadNativeAgentSessions()`, which reads and parses all 2,000 sessions (146-161 ms) to find one environment's keys. `deleteAgentMailByEnvironment` (`storage-agent-mail.ts`) loads the whole agent-mail document and saves it whole through `saveSensitiveJson` (116-131 ms at about 20 MiB). A CPU profile puts the time in `readStore` and in `saveSensitiveJson`. Every other store call in the delete took under 10 ms.

**Decisions.**

- **How to bound it?**
  - **Remove the whole-store passes: find an environment's native sessions from a per-environment index or the cached snapshot, and store agent mail as rows by mailbox (recommended).**
    - Pros: the cost no longer grows with the size of the store, for every caller and not only deletes.
    - Cons: an agent-mail layout change needs a storage migration, and the native-session sweep must keep its rule that no key can appear behind it.
  - **Yield to the event loop between the delete's store steps.**
    - Pros: a few lines in `deleteEnvironment`.
    - Cons: concurrent deletes' yields are served together, so the gap still grows with the number of deletes, and the total work is unchanged.

## Assumptions and decisions

### Task 2: staging the failure

Chose the recommended fixture. An agent-test backend (`ORKESTRATOR_AGENT_TEST_ISOLATED=1`) reads a per-environment marker file, `<data dir>/agent-test-fixtures/terminal-survives-terminate/<environment id>`; while it exists, `terminateSessionsForEnvironment` leaves that environment's terminals running and reports them as survivors (`agent-test-fixtures.ts`, `TerminalRuntime`'s `survivesTermination`). A marker file was chosen over an environment variable or a command so a spec can switch it per environment and remove it before the retry without restarting the profile, and so production never consults it (the option is `undefined` outside agent-test profiles). The spec deletes from the row's context menu, sees the reason and **Retry** after a reload, removes the marker and finishes the delete with **Retry**. #1902 had meanwhile added a second real failure (an unwritable seed directory) whose delete starts from a direct command; both specs now run in the same file.

### Task 3: where progress comes from

Chose the recommended option: the delete records its stage on the environment record (`deletionStep`), seven fixed stage names from `@orkestrator/protocol/node-summaries`, and node summaries relay it as `deletingStep`. The row appends the stage to the existing two-minute notice ("Still deleting after 5 min: removing the worktree") rather than adding a line, so a fast delete shows nothing new. Only a running, unfailed delete shows a stage, and only one this client knows. The record write is best-effort and costs one store update per stage. `deleteEnvironment` moved from `commands-servers.ts` to `environment-delete.ts` (the former was close to the 2,000-line limit); `commands-servers.ts` re-exports it.

### Task 4: what bounds a hang

Chose the recommended deadline per external stage: 10 minutes for `container` and 20 for `worktree`. A deadline requests cancellation; the delete guard remains held until local commands and their private process groups are confirmed stopped. Deletion commands explicitly use `waitForTermination` and `waitForDescendants`, including per-command timeouts and output overflow. The macOS lost-exit watcher remains active during cancellation. Unknown termination keeps the guard held even beyond the deadline. Sending SIGKILL alone is insufficient: rejecting immediately could admit an overlapping retry.

The same signal-aware runner now reaches network inspection/removal and current and retained container ownership probes as well as the drain, volumes, gateways and worktree commands. The confined-removal helper waits for exit. No later command starts after cancellation, and the ledger retains interrupted work. Tests separately hold leader and descendant termination and verify Retry is refused, drive deadlines through each container stage, and cover resource-only cleanup with no current runtime.

Docker can continue work it accepted after its CLI exits; local termination does not prove daemon-side completion. Retry checks resource existence and ownership and treats absent resources as removed. Stages that run in the backend (terminal teardown, store writes) retain no overall deadline because their work cannot be cancelled safely.

### Task 5: what readiness means

Chose to leave `established` as "the helper's `fs.watch` returned", the recommended option, on this evidence. On 2026-11-06, on this 18-core Mac (macOS 27.2, load average about 14, `fseventsd` sampled at 3-58%), 20 watches through the real helper (`watchDirectory`), each writing one new file every 20 ms from the moment `established` resolved, 250 files each, received 4,999 of the 5,000 files. The one miss was the first file of one watch, written 22 ms after `established`; the first event reached the backend 38-102 ms after it. Ten watches were in the temporary directory and ten inside the checkout. So the gap a probe write would close is tens of milliseconds on an ordinary host, while under a saturated `fseventsd` (the 2026-11-05 run below) events are lost after the stream is running too, which only the safety scan (120 s for a local worktree) covers. The probe option would also leave every watch unqualified on a host that delivers nothing. Recorded in [environment-deletion.md](../../architecture/environment-deletion.md#watches-and-the-event-loop).

### Task 6: how the store cleanup is bounded

Chose the recommended option, removing both whole-store passes, plus one yield inside the agent-mail delete. Measurements are in [environment-deletion.md](../../architecture/environment-deletion.md#the-work-a-delete-does-besides-watches).

- **Native sessions: an indexed owner, not a second store.** `native-agent-sessions` rows now carry their environment in the existing `store_rows.owner` column (the layout's owner extractor), so `deleteNativeAgentSessionsByEnvironment` lists its keys with `listStoreRowKeysByOwner` and reads no value. A separate per-environment index store was the alternative; it would be a second write on every session create and a second record to keep consistent, where the owner column is written in the same row by the same statement.
- **No schema version for the backfill.** Rows written before the owner existed get it from `backfillNativeAgentSessionOwners` at every open, in one transaction, the way `store_rows_position` is created on open. A numbered migration would have run once but bumped `user_version`, which makes every older build refuse to open the database. The cost is that an older build sharing the directory writes rows without an owner; the next open fixes them.
- **The sweep still finds rows with no owner.** Its rule that no key escapes it does not depend on the backfill: rows with no owner are read through a partial index holding only those rows (`store_rows_unowned_native_agent_sessions`, from `StorageDatabaseOptions.unownedRowIndexes`) and checked individually. Without the index that read walked the store's rows (12-48 ms on beelink under load); with it it costs the rows it returns, normally none. Inserts still check the deletion tombstone in their commit, so nothing new appears behind the sweep. A store held as a document, or buffered by an atomic scope, is still read whole.
- **Agent mail: row writes on the existing layout, no migration.** Agent mail was already stored as rows by mailbox (an envelope with `mailboxes`, `idempotency` and `counterparts` collections). The cost was in the delete cloning the whole store and the save reserializing every row. The delete now plans from the shared frozen read model (`storage-agent-mail-deletion.ts`, shallow copies of only the messages it changes) and commits through the new `StorageDatabase.updateStoreRows`: the changed rows and the envelope document (revision and inject queue) in one transaction, carrying the connection's row cache forward. No layout change or storage migration was needed, which the to-do had expected.
- **The row write counts as a leased write.** `updateStoreRows` commits rows planned from an earlier read, so the writer guard (`storage-writer-guards-test-support.ts`) classes it with whole-value writes: it must run inside the store's lease, which every agent-mail writer shares. Agent mail therefore keeps one kind of writer, as the storage rules require; a test moves the call outside the lease and the guard refuses it.
- **Fallbacks keep the whole-value save.** Inside an atomic scope, while a retired JSON copy of the store remains (whose pruning commits with a whole-value save), or for a store held as a document, `updateStoreRows` answers `false` and the delete uses `load()` and `save()`. A test checks both paths leave the same store.
- **The size limit refuses growth only.** A row write that shrinks the store commits even past the 32 MiB limit; the whole-value save refused any result over the limit, which could have stopped a delete on a store already over it.
- **One yield between reading and committing.** The mail delete awaits `setImmediate` after planning, holding the mail lease, so its two synchronous blocks become two gaps. Yields alone were the to-do's other option; here it is only a split, on top of the reduced work.
- **What it does not change.** A delete still rewrites every mailbox holding mail the environment sent; in the benchmark's workload that is all 200, so the agent-mail call is no faster there. Repeating a delete marks the sender's already-expired messages again, as it did before.
- **File size.** `storage-database.ts` would have passed 2,000 lines, so its pure row helpers moved to `storage-database-rows.ts`.

## Current state

Directory watches on macOS run in a helper process, the worktree is no longer watched while it is removed, recovery stands aside while a delete runs, and a failed delete shows its reason with a retry. A slow delete names the stage it is on, the container and worktree stages request cancellation at a deadline and fail only after local termination is confirmed, and an agent-test profile can stage a real failed delete on demand. A delete finds its native sessions by their indexed environment and commits only the agent-mail rows it changes. What remains is task 1 (live confirmation on `arktech-mini`, which needs a release containing the fix).

## Needs verification

Six concurrent `git worktree remove` runs finished within 5 ms of each other before the fix, and six whole deletes within about 65 ms of each other after it, although nothing serializes them. The cause was not established, and it costs no event-loop time.

## Related

- [environment-deletion.md](../../architecture/environment-deletion.md)
- [0735-git-fsmonitor-follow-ups.md](0735-git-fsmonitor-follow-ups.md)
