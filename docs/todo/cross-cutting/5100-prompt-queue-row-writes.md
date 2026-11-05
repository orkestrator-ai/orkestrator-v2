# A steer's prompt queue step still decodes every queue

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`; re-checked 2026-11-05 against `main` at `6e796ca32` and built that day. The line numbers below are from the first analysis. Carried from part `0230` (TX-4's rest, task 1) of the E6 efficiency batch, whose report was deleted when E6 landed; it stays in git history at `e198fd4a7`, under `docs/reports/efficiency-logging-database/`.

### Tasks

1. **Move the prompt-queue writers to row writes**: every writer of `prompt-queues` together, so a queue mutation, and a steer's reservation and settlement with it, decode and rewrite one queue. Status: done (2026-11-05).

### 1. Move the prompt-queue writers to row writes

**Problem.** E6 moved every native session mutation to a single-row read, and `readNativeAgentPublicationState` now reads one queue row. Two steer paths cannot follow: `reservePromptQueueSteer` and `settlePromptQueueSteerSource` still load every prompt queue inside the session's lease, because they end in a whole-value save. The cost scales with the number of queues, not the one being changed.

**Context.** The report named these sites as needing "their own read" (`storage-native.ts:1197`, `storage-native-deliveries.ts:509`, `:600`). It did not say a read alone is impossible here: `saveSensitiveJson` writes a store's complete value, so handing it one queue would delete the others. Writers of one store must all be leased whole-value saves or all row writes (`storage-writer-guards.test.ts`), so these two cannot move alone.

**Investigation.** The whole-value writers are `storage-native-deliveries.ts:539` and `:592`, `storage-prompt-queue-store.ts:88`, and `storage-prompts.ts:721`, `:744`, `:798`, `:847`, `:868` and `:889`. Whole loads under the queue lease are at `storage-prompts.ts:226`, `:270`, `:314`, `:381`, `:477`, `:558`, `:622`, `:669`, `:701`, `:732`, `:779`, `:814`, `:858` and `:883`, plus the two steer paths. Most change one key. `deletePromptQueuesByEnvironment` changes several and scrubs archives. `restoreLegacyPromptQueueClaims` runs on every load; `loadPromptQueue` already applies it to one row. `updateSensitiveStoreRow` keeps the archive pruning a whole-value save does, as compose drafts showed. Nothing here was measured.

**Decisions.**

- **How to remove the whole-queue reads?**
  - **Move every writer together to `updateSensitiveStoreRow` under the queue lease, as compose drafts and environments did (recommended).**
    - Pros: one row per mutation; keeps the lease order and the archive pruning; the writer guard proves no writer was missed.
    - Cons: a change across a sensitive dispatch path; a journaled save stores a copy of the row in the cleanup store while an archive exists; needs its own before-and-after numbers.
  - **Leave them until measured.**
    - Pros: no risk to prompt delivery; a typical install has few queues, each small unless it holds pasted attachments.
    - Cons: a queue holding attachments can reach 32 MiB, and every other queue's mutation then decodes it.

## Current state

Every writer of `prompt-queues` is an `updateSensitiveStoreRow` under the queue lease, through `PromptQueueStore.updatePromptQueue` or, for deletion, `deletePromptQueuesOwnedBy`. A single-queue mutation decodes one queue. `listPromptQueues`, `listAllPromptQueues` and environment deletion through `deletePromptQueuesOwnedBy` still decode every queue; those scans are [6020](6020-prompt-queue-scans-decode-every-queue.md). The store's format is unchanged, so older and newer backends keep sharing it under the same lease.

## Constraints and rationale

A queue row's claim recovery and validation must stay what `loadPromptQueues` applies. A session lease is taken before the queue lease, never the reverse.

## Related

- [1202](1202-efficiency-review-follow-ups.md) task 2
- [6020](6020-prompt-queue-scans-decode-every-queue.md): the listing and environment-deletion scans
- [Storage: Concurrency](../../architecture/storage.md#concurrency)

## Assumptions and decisions

### Re-check against E5 (task 1)

The recommended option still fits. E5 (#1810) added database upkeep and ledger snapshots and moved the change ledger; its diff does not touch `updateSensitiveStoreRow`, the row primitives or the cleanup journal. The writers were as listed, plus one read to move: `withEmptyPromptQueueForMail` also loaded every queue.

### Sync mutations run inside the row transaction (task 1)

A mutation that does not await reads and writes in one transaction, so it parses its row once and a throw writes nothing. `enqueuePromptQueueMessageIfAbsent` and `reserveNativeAgentJobRequest` read the native session between read and write, so they read the row, await, then write it, under the lease, and parse that row twice. Their order of reads is unchanged.

### A reservation announces after its session write (task 1)

`updatePromptQueue` announces after its commit, except a steer reservation, which still announces only once the session holds `pendingSteer`, as it did.

### A row write no longer clears other queues' bad rows (task 1)

A whole-value save used to replace a store with an unparsable row, losing every queue, and to drop invalid rows of any queue. Row writes do neither, which would have left one unparsable row hiding every queue from the scans and from deletion for good. So:

- `loadPromptQueues` parses row by row, and a bad row costs only itself. An unreadable document still reads as empty.
- `updateStoreRow` gained `unreadableRow: "replace"`, used only by this store, so a queue's next write replaces its own bad row. The default still refuses.
- An invalid row naming another environment survives, which keeps a newer build's record intact. Environment deletion removes rows naming that environment or none, except unattributed tmux rows whose keys do not match that environment. Rows with no owner in either their value or key used to go on any write; now they go on the next environment deletion.

Compose drafts and native sessions refuse an unparsable row of their own key instead. Queues do not, because replacing is what a whole-value save did here, and a refusal would block that tab's queue until someone repaired the row.

### Deletion is one row write per queue (task 1)

- **Per-row `updateSensitiveStoreRow` (chosen).** Each removal journals a `delete-row` holding no content, and the sweep can remove an unparsable row. A crash part-way is no longer all-or-nothing, but the rest is finished by a retry; a test covers it. Each removal also replays the archive cleanup, so with an archive it costs more per queue.
- **One `updateStore(..., { sensitive: true })`, as compose drafts do.** Atomic across rows, but it journals a copy of the whole store, and an unparsable row reads the store as absent, so it would replace every queue with nothing.

### Recovery persists per queue (task 1)

An expired legacy claim is now written back only when that queue is next written, not on any queue's write. Every read still recovers it, with the same stable id.

### Before and after numbers (task 1)

Ad hoc run of the public storage methods with local fixtures in a temporary data directory, old then new source back to back, 2026-11-05, on a host running other test suites (load average 27 to 40). Time is the median per operation in ms and is noisy; decoded is the KiB through `JSON.parse` per operation and is repeatable. "reserve+ack" also includes a read and a whole-list save that puts the item back. Row writes per operation were the same before and after.

| Store | Operation | ms before | ms after | KiB decoded before | KiB decoded after |
| --- | --- | ---: | ---: | ---: | ---: |
| 2000 small queues | enqueue | 66.77 | 2.08 | 3696.4 | 1.6 |
| | remove | 52.81 | 2.67 | 3696.5 | 1.6 |
| | reserve+ack | 175.80 | 4.37 | 11089.9 | 5.3 |
| | steer reserve+settle | 88.41 | 5.54 | 7395.8 | 6.0 |
| | delete environment (3 queues) | 55.90 | 57.74 | 3679.2 | 3681.6 |
| 20 queues + 30 MiB sibling | enqueue | 112.64 | 0.86 | 30779.4 | 1.5 |
| | remove | 28.75 | 0.71 | 30779.4 | 1.5 |
| | reserve+ack | 216.57 | 2.11 | 92338.9 | 5.3 |
| | steer reserve+settle | 105.87 | 3.41 | 61561.8 | 6.0 |
| | delete environment (3 queues) | 51.17 | 86.32 | 30769.4 | 30771.8 |
| 2000 small queues, archive | enqueue | 156.13 | 2.42 | 7363.5 | 1.5 |
| | remove | 555.87 | 88.87 | 14851.1 | 3746.5 |
| | steer reserve+settle | 1071.43 | 199.08 | 29703.0 | 7493.9 |
| | delete environment (3 queues) | 739.84 | 380.83 | 18538.4 | 18600.8 |
| 20 queues + 30 MiB sibling, archive | enqueue | 827.30 | 138.63 | 61539.2 | 1.4 |
| | remove | 3969.11 | 627.30 | 123080.2 | 30773.2 |
| | steer reserve+settle | 6963.86 | 1171.98 | 246161.5 | 61547.4 |
| | delete environment (3 queues) | 3053.74 | 2043.14 | 153818.8 | 153820.3 |

The costs that remain:

- **A queue holding 30 MiB, mutating itself, costs slightly more.** It decodes the same bytes. Median CPU over two alternating rounds, before then after: enqueue about 1085 and 1182 ms, remove 1060 and 1198 ms, reserve+ack 3151 and 3774 ms, steer 2162 and 2435 ms. Wall time was within noise. Not profiled. A likely cause is that the old whole load kept the row in the connection's cache, so a later row read skipped the SQLite fetch, at the price of holding every queue in memory.
- **With an archive, a removal still parses the archived copies** while pruning them, so the archive's size still counts until the archive expires. An append removes nothing and skips this.
- **Environment deletion still decodes the whole store**, since it has to find the owner's rows. It is rare, and it decodes the same bytes as before. Its wall time moved both ways between runs under this load: with 2000 queues and an archive, 120 to 247 ms in one run and 740 to 381 ms in the table's.


### Review repairs (task 1)

Environment deletion remains a full-store scan; the writer guard now enumerates both listing and raw-row scan callers. Damaged tmux rows are retained when their keys do not match the environment being deleted, rather than deleting another environment's recoverable data. Deletion announces committed readable removals in a finally block, so a later failure still notifies listeners once. Regression coverage includes partial-failure notifications and unreadable rows with retired archives for both replacement and deletion.
