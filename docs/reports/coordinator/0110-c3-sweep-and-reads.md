# C3: Sweep and reads

This file combines 2 reports into one batch to build together. `0110` makes reads cheap. `0370` routes the copies through the same mailbox check.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0110](#0110-the-sweep-and-every-snapshot-repeat-global-work) | Medium | Syncing once per sweep, a read-only `snapshot()`, batched wake writes and pruning below the limit. |
| [0370](#0370-duplicated-mailbox-authorization-and-runtime-ids-in-the-control-mcp-tools) | Low | One own-mailbox check, and `coordinatorRuntimeId` everywhere. |

## 0110: The sweep and every snapshot repeat global work

### Task analysis

#### Tasks

1. **Sync once per sweep**: the mailbox sync and association scans run once, not per workspace. Status: done.
2. **Make `snapshot()` read-only**: reads stop doing adoption and mail moves; repair stays in the sweep. Status: done.
3. **Batch the wake writes**: one mutation and one announcement per delegation wake. Status: done (two writes, one announcement).
4. **Prune below the limit**: finished records leave on a schedule, not only when the store is full. Status: not done, measured; open in to-do 6660.

#### 1. Sync once per sweep

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

#### 2. Make `snapshot()` read-only

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

#### 3. Batch the wake writes

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

#### 4. Prune below the limit

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

### Needs verification

The cost was read from the code, not measured. Tasks 1 and 2 should record sweep and read time on a store with many workspaces before and after.

## 0370: Duplicated mailbox authorization and runtime ids in the Control MCP tools

### Task analysis

#### Tasks

1. **Use one own-mailbox check**: the three copies call `ownConversationMailbox`. Status: done.
2. **Use `coordinatorRuntimeId`**: replace the hand-built ids. Status: done.

#### 1. Use one own-mailbox check

**Problem.** An authorization rule is copied three times, so a fix to one can miss the others.

**Context.** `control-mcp-tools.ts` is now 2,411 lines (2,002 in the report).

**Investigation.** The helper is at `:392-412`, used once (`:2114`). Copies are at `:2240-2259`, `:2285-2304` and `:2372-2391`. They differ only in the error text ("read" or "acknowledge"). The helper finds a conversation by id whether or not it is closed, as they do, so behaviour would not change.

**Decisions.** None: a small `assertOwnMailbox(input, verb)` built on the helper.

#### 2. Use `coordinatorRuntimeId`

**Problem.** The `coordinator:<id>:<conversation>` format is written by hand in several places.

**Context.** The helper is in `@orkestrator/protocol/coordinator`.

**Investigation.** `control-mcp-tools.ts:407`, `:2240`, `:2285`, `:2324`, `:2372`, `control-mcp-server.ts:583` and `scheduled-jobs/service.ts:560`.

**Decisions.** None: mechanical replacement. `control-mcp-tools.ts` already imports from that module.

## Outcome

Built from `main` at `cd7e963ec` (C2, #1859, already merged). Every finding was re-checked against that commit first: the line numbers had moved, but every finding still held and none was already done.

### Measurement

`apps/backend/scripts/coordinator-sweep-bench.ts` builds an isolated synthetic store in the system temporary directory: 40 projects, each with one coordinator, 10 running delegations (each on a running local environment) and 35 closed and woken ones, so 1,800 of the 2,000 workflow records. It times one `reconcileWorkerDelegations` (the 60 s sweep), one `CoordinatorService.get` (`get_project_coordinator`, and every coordinator `read_messages`) and one `get_project_coordinator_view` (the panel), 20 times each, on the same host, before and after. "Before" ran this branch's script with `coordinator-service.ts` and `storage-coordinators.ts` checked out at `cd7e963ec`. Mean milliseconds per call, two runs each:

| Store | Sweep before | Sweep after | Read before | Read after | View before | View after |
| --- | --- | --- | --- | --- | --- | --- |
| 1,800 records (1,400 finished) | 797, 846 | 53, 56 | 15.7, 15.9 | 5.2, 5.6 | 15.5, 16.1 | 5.4, 6.0 |
| 400 records (none finished) | 398, 400 | 48, 48 | 9.5, 9.6 | 3.3, 3.5 | 9.6, 9.7 | 3.4, 3.5 |

The store owed no repair, so neither version wrote during these runs (0 coordinator and 0 agent mail store revisions per call). That reads do not write when repair is owed is shown by `coordinator-sweep.test.ts` rather than by the timing.

### Task by task

| Part, task | Outcome | Evidence |
| --- | --- | --- |
| 0110, 1: sync once per sweep | Done | `reconcileClosedConversations` (`coordinator-closed-conversations.ts`) adopts per coordinator from one `getCoordinatorReconciliationState` read, then syncs mailboxes once and reads the owed set once (`listOwedCoordinatorDelegationIds`, one read for open and unwoken) for every coordinator's mail move. Each move reads the mail store afresh under its lock and only touches its own coordinator's mailboxes; adoption does not change which delegations are owed, so one owed set holds for the pass. The per-delegation re-check under the worker's admission lock uses one read and reads again only after the store revision moved (`readOpenDelegations`, `coordinator-open-delegations.ts`; `coordinatorStoreRevision`). Tests: "runs the mailbox sync and the delegation scans once for several coordinators", "re-checks a delegation against a fresh read once the store has changed", "moves each closed main's mail to its own next main in one pass" (`coordinator-sweep.test.ts`). |
| 0110, 2: read-only `snapshot()` | Done | `snapshot()` calls no repair. Test: "repairs nothing and writes nothing; the sweep still does the repair" reads through `get`, `get_project_coordinator` and `get_project_coordinator_view` with an adoption owed and checks no coordinator store revision, no change announcement, no mailbox sync and no mail move. The paths that open a main are listed below. Closing a conversation runs its own repair, which the read after it used to do, so a closed side's open work still moves to the main at once (test: "closing a side conversation still moves its open work to the main at once"). |
| 0110, 3: batch the wake writes | Done, as recommended | `closeOnDecision` closes with the wake kind in the same write, unannounced. The kind is chosen inside `closeCoordinatorDelegation`'s store lock from the record's own coordinator, so the main cannot close in between; with no main open it is left unset and the wake pass chooses and writes it as before. `wokenAt` stays a separate write after delivery and is the one announcement; a wake that stops short of it announces the close once after its attempt. `prepareCoordinatorDelegationWake` no longer announces. Tests: "with a report/notice writes close and kind, delivers, then stamps, announcing once" (two writes, delivery after the first, one announcement at the second), "with a report/notice, a crash between delivery and its stamp wakes once" (a restart in that gap leaves one message), "that cannot be delivered still announces its close once". |
| 0110, 4: prune below the limit | Not done: the measurement does not show it is needed | At 40 coordinators, 1,400 finished records add 5 to 8 ms to a sweep that runs every 60 s, and about 2 ms to a read or view. Pruning earlier would remove `list_workflows` history the docs promise to keep. The synthetic store is the only evidence; a real large store was not available here. Open in [to-do 6660](../../todo/coordinator-and-multi-review/6660-c3-sweep-and-reads-follow-ups.md), task 1. |
| 0370, 1: one own-mailbox check | Done | `assertOwnMailbox(invoke, scope, input, verb)` on `ownConversationMailbox`, used by `read_messages`, `get_message` and `ack_message`, with the same two error texts. Test: "a coordinator reads and acknowledges only its own conversation's mailbox" (`control-mcp-server-messaging.test.ts`), which refuses another conversation's mailbox and the wrong tab for all three tools without reaching the mail store, and allows its own. |
| 0370, 2: `coordinatorRuntimeId` everywhere | Done | `control-mcp-tools.ts` (the helper and `get_message_status`), `control-mcp-server.ts` (the invoker's own-runtime check) and `scheduled-jobs/service.ts` (`coordinatorConversationClosed`). No `coordinator:${…}` template remains in those files. The protocol's `scheduleOwnerKey` still builds the same string for side schedules; it is outside the files this part named and was left alone. |

### Paths that open a main

Checked against every writer of a coordinator workspace in `apps/backend/src`. Each path that opens a main takes over what a closed main left:

- `ensureMainConversation`, through `settleOpenedMain` (all other conversations' live work, then the mailbox sync and the closed main's mail). It is reached from mail to `coordinator` or to a closed conversation (`mainMailAddress`, the storage mail resolver), every delegation wake, the node-release notice address (`CoordinatorNodeReleases.mainAddress`) and a new notice (`startMainForNotice`).
- `ensure` creating a coordinator: its first main gets the same sync (nothing to move yet).
- `createConversation` with no main open (**Start coordinator**, **Change agent**): it runs the closed-conversation repair itself. It does not call `ensureMainConversation`, which would also give the new main an agent; a new conversation is deliberately unassigned.
- No call path: a record from before roles that `normalizeCoordinatorRoles` gives a main on read or write, and a restored or imported store. These take the mail over on the next sweep, within 60 s.

Every other workspace writer (`project-git-service.ts`, `commands-servers.ts`, `commands-local-server-lifecycle.ts`, `native-agent-service.ts`, `index.ts`) only updates fields of conversations that already exist.

### Decisions

- **Re-reading open delegations in the sweep.** The re-check under each worker's admission lock is kept, because a turn end, a stop or a follow-up can change the record between the sweep's read and the lock. Chosen: compare the store's committed revision (`coordinatorStoreRevision`, one SQLite row) and read again only when it moved. Alternatives: drop the re-check (cheapest, but would decide on stale `stopRequestedAt` or `requestedAt`); read one record by id (still parses the whole store, which is what costs). The sweep that closes nothing now reads the list once.
- **Where the wake kind is chosen at close.** Chosen: inside `closeCoordinatorDelegation`'s lock, from the coordinator record in the same loaded store, so a main close cannot land between the choice and the write. The earlier separate write read held mail after the close had committed; the merged one reads it just before. A worker report already past its hold decision when the close commits could be missed either way; a report sent after the close is never held, so the choice cannot otherwise go stale.
- **`createConversation` and `ensureMainConversation`.** Chosen: the shared repair step rather than calling `ensureMainConversation`, which assigns the default agent to an unassigned main. A new main from New conversation keeps no agent, as before.
- **Splitting `coordinator-service.ts`.** The service would have reached 2,146 lines, so the closed-conversation repair moved to `coordinator-closed-conversations.ts` and the open-delegation lookup to `coordinator-open-delegations.ts`, as modules taking the storage they need (1,980 lines left).

## Related

- [Coordinator report, 4.2 (B7)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability) and [6, reads that write](../2026-10-27-coordinator.md#6-maintainability)
- [1202-efficiency-review-follow-ups.md](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md): lists the coordinator among background callers still to be moved
- [Coordinator report, 6](../2026-10-27-coordinator.md#6-maintainability)
