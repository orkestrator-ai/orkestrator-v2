# Native session mutations still decode the whole store inside the lease

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Load one row inside the key's lease**: replace whole-store loads in native session mutations with a single-row read. Status: open.

### 1. Load one row inside the key's lease

**Problem.** The read half of TX-4 is fixed, but a mutation of one session still parses and validates every session in the store. A busy backend pays that per mutation, and it scales with stored sessions.

**Context.** 1202 tracks this as "TX-4's rest" under task 2. The writer is already row-level: `saveNativeAgentSession` is a transactional `updateStoreRow` under a per-key lease, and `storage-writer-guards.test.ts:85-96` pins that. So moving the read does not hit the one-kind-of-writer rule that blocks environments.

**Investigation.** `loadNativeAgentSessions` (`apps/backend/src/core/storage-native.ts:352`) decodes every row and sorts them into `sessions` and `opaque`. A text search today finds 20 calls in `storage-native.ts` and 12 in `storage-native-deliveries.ts`. Most are mutations such as `recordNativeAgentActivityTurn` (`storage-native.ts:1208-1209`); some are true whole-store reads such as `migrateNativeAgentSessionOwners` (`:200`), which stay. 1202 counted 22 lease-held sites on 2026-11-02. `assertReadableNativeAgentSession` is called with the loaded result (`:1210`), and `getNativeAgentSession` (`:415-436`) already shows how to keep its refusal: `storeHeldAsDocument` falls back to the whole load.

**Decisions.**

- **How to move them?**
  - **A shared lease-held row read, modelled on `getNativeAgentSession`, moving each mutation in turn (recommended).**
    - Pros: one helper keeps the unreadable-record refusal; each call site can be checked by itself; writers do not change.
    - Cons: sites that read a second session or the prompt queue (`storage-native.ts:1197`, `storage-native-deliveries.ts:509`, `:600`) need their own read.
  - **Leave them until measured.**
    - Pros: no risk to a sensitive path.
    - Cons: mutation cost keeps scaling with stored sessions; the instruments that would show it exist but were not run.

## Current state

Done, checked in code:

- `getNativeAgentSession` reads one row with `loadStoreRow` (`storage-native.ts:424`, landed in #1548, `12289fc56`).
- `getPromptQueue` goes to `loadPromptQueue`, also one row (`storage-prompt-queue-store.ts:126-127`).
- `workerProjection` reads the shared frozen snapshot rather than a fresh decode (`index.ts:1765`, #1605, `381b26f90`).

So the report's actual finding, that every transcript and state read parses every row, no longer holds.

## Constraints and rationale

- A mutation must keep refusing an unreadable record for its key. Other keys' rows, including unreadable ones, must never be rewritten.
- Mutating a row read inside the lease must not touch the frozen snapshot objects, which are shared.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) apply as usual.

## Needs verification

- Which of the 32 call sites are mutations; the count above is a text search, not a classified list.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-4), and ST-7 to ST-10 in [section E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 task 2](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
