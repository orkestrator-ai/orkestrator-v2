# The sweep and every snapshot repeat global work

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Sync once per sweep**: the mailbox sync and association scans run once, not per workspace. Status: open.
2. **Make `snapshot()` read-only**: reads stop doing adoption and mail moves; repair stays in the sweep. Status: open.
3. **Batch the wake writes**: one mutation and one announcement per delegation wake. Status: open.
4. **Prune below the limit**: finished records leave on a schedule, not only when the store is full. Status: open.

### 1. Sync once per sweep

**Problem.** The cost of each sweep grows as workspaces × environments.

**Context.** `coordinator-repair` runs every 60 s.

**Investigation.** `reconcileWorkerDelegations` calls `reconcileMainMail` per workspace (`coordinator-service.ts:1012-1015`). Each call runs `synchronizeAgentMailboxes` (`:325`) and two full delegation scans (`:330-331`) and `adoptLiveWork` scans again (`:354`). `listOpenCoordinatorDelegations` is re-read inside the per-delegation loop (`:1022`), which is quadratic in open delegations.

**Decisions.**

- **How to share the work?**
  - **Split `reconcileMainMail` into a global step and a per-workspace step, with the owed set passed in (recommended).**
    - Pros: the sync runs once; the structure says what is global.
    - Cons: `moveClosedCoordinatorMail` must still see a fresh set after moves in earlier workspaces, so ordering needs care.
  - **Memoise the sync for a short time.**
    - Pros: small diff, and it helps other callers too.
    - Cons: a time-based cache in a path whose correctness depends on what it read.

### 2. Make `snapshot()` read-only

**Problem.** Every read of a coordinator does repair with writes, so read latency includes a full mailbox sync.

**Context.** The panel calls `get_project_coordinator_view` on each `coordinator` change, and the digest in `coordinator-view-revisions.ts` saves only the response body, not this work. Each wake's announcements trigger more reads (task 3).

**Investigation.** `snapshot` calls `reconcileMainMail` at `coordinator-service.ts:515`. `get_project_coordinator` is also how the tools read their own conversation: `ownConversationMailbox` (`control-mcp-tools.ts:396`) and the mailbox reads at `:2241`, `:2286` and `:2373`, so an agent's every `read_messages` runs it too: `get_project_coordinator` and the view command both call `coordinators.get` (`commands-registry-coordinator.ts:131-134`, `:158-163`).

**Decisions.**

- **What keeps closed-main mail moving?**
  - **`ensureMainConversation` plus the sweep (recommended).** A new main already reconciles there (`:315-316`).
    - Pros: reads become cheap and safe; matches the report's split.
    - Cons: a mail move can lag up to 60 s behind a main opened by another path; needs a check that every such path goes through `ensureMainConversation`.
  - **Keep repair in `snapshot()` but run it behind a per-project cooldown.**
    - Pros: repair stays prompt for an open panel.
    - Cons: reads still write, which the report's section 6 names as the root problem.

### 3. Batch the wake writes

**Problem.** One wake rewrites the store and announces a change three times.

**Context.** The sequence is crash-safe by design: close, record `wakeKind`, deliver, then stamp `wokenAt`. Delivery has to sit between the last two.

**Investigation.** `closeCoordinatorDelegation` (`storage-coordinators.ts:756-776`), `prepareCoordinatorDelegationWake` (`:786-798`) and `markCoordinatorDelegationWoken` (`:804-815`) each save and announce.

**Decisions.**

- **What can be merged safely?**
  - **Merge close and `prepare`; keep `wokenAt` separate, and announce only after the final write (recommended).**
    - Pros: two writes, one announcement, and the crash-safety order is kept.
    - Cons: a `running` to `closed` change is not announced until delivery ends, so the Work panel lags by the length of the pass.
  - **Merge all three.**
    - Pros: the report's one mutation.
    - Cons: the mail send cannot be inside that write, so a crash could lose the wake or send it twice.

### 4. Prune below the limit

**Problem.** Sweeps, snapshots and view digests walk the whole list, and retention runs only at 2,000 records.

**Context.** `snapshot.workflows` is the full project list, digested on every view read.

**Investigation.** `makeRoomForWorkflowAssociation` returns at once below the limit (`storage-coordinators.ts:149`).

**Decisions.**

- **Prune on a schedule?**
  - **Measure first, then run the same selection from the sweep if a real store is large (recommended).**
    - Pros: no new behaviour without evidence; the selection already exists and is tested.
    - Cons: the cost stays until someone measures.
  - **Prune every sweep now.**
    - Pros: lists stay short.
    - Cons: the docs promise history stays until needed; `list_workflows` would lose rows earlier.

## Needs verification

The cost was read from the code, not measured. Tasks 1 and 2 should record sweep and read time on a store with many workspaces before and after.

## Related

- [Coordinator report, 4.2 (B7)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability) and [6, reads that write](../2026-10-27-coordinator.md#6-maintainability)
- [1202-efficiency-review-follow-ups.md](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md): lists the coordinator among background callers still to be moved
