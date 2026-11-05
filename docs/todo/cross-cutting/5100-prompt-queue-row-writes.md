# A steer's prompt queue step still decodes every queue

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`. Carried from part `0230` (TX-4's rest, task 1) of the E6 efficiency batch, whose report was deleted when E6 landed; it stays in git history at `e198fd4a7`, under `docs/reports/efficiency-logging-database/`.

### Tasks

1. **Move the prompt-queue writers to row writes**: every writer of `prompt-queues` together, so a queue mutation, and a steer's reservation and settlement with it, decode and rewrite one queue. Status: open.

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

The session half of both steer paths reads one row. The queue half is unchanged and correct: it holds the queue lease for a whole-value save.

## Constraints and rationale

A queue row's claim recovery and validation must stay what `loadPromptQueues` applies. A session lease is taken before the queue lease, never the reverse.

## Related

- [1202](1202-efficiency-review-follow-ups.md) task 2
- [Storage: Concurrency](../../architecture/storage.md#concurrency)
