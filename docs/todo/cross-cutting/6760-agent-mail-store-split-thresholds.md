# Agent mail store: when splitting pending injects and bodies would pay

## Task analysis

Analysed 2026-11-05 against `main` at `cbe0f9a5b`. From efficiency report part `0560` (ST-9's rest), which was checked back against the code, measured and deleted; see its closing check (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`).

### Tasks

2. **Pending injects as their own collection**: stop keeping them in the store's envelope. Status: blocked (waits on 7568: 6760 task 1).
3. **Mailbox list without message bodies**: serve the list, and keep the read model, without bodies. Status: blocked (waits on 7568: 6760 task 1).

### 2. Pending injects as their own collection

**Problem.** Pending injects live in the envelope document (`pendingInject`, `apps/backend/src/core/storage-agent-mail-store.ts:78-108`), so any change to one goes through a whole-store load and save.

**Context.** The layout's collections are `mailboxes`, `idempotency` and `counterparts` (`apps/backend/src/core/storage-stores.ts:79`). The queue is rebuilt from the messages on every load (`normalizeStore`, `storage-agent-mail-store.ts:219-241`) and scanned by `storage-agent-mail-injects.ts` (`listPendingAgentMailInjects`, `:499`). Every writer runs `load` then `save` inside `enqueue`: 24 sites across `storage-agent-mail.ts`, `storage-agent-mail-directory.ts`, `storage-agent-mail-injects.ts` and `storage-agent-mail-budgets.ts`.

**Investigation.** Re-checked: still true. Measured with `apps/backend/scripts/agent-mail-store-size-bench.ts` (see Current state for the table). The cost of a mail write is the whole-store `load` (every row parsed, then normalised) plus `save` serialising every row to find the changed ones (`decompose` in `writeStoreInTransaction`, `apps/backend/src/core/storage-database.ts:704-769`). A change to pending-inject entries alone (`resetAgentMailInjectBackoff`) costs the same as a send: 4–8 ms CPU at 1.85 MB, 17–20 ms at 7.9 MB and 44–53 ms at 28.9 MB. The envelope itself is 68 KB with 600 pending injects (about 113 bytes an entry, so about 226 KB at the 2,000-entry cap). Moving the queue into its own collection would not change those figures: writers would still load and serialise the whole store. It would shrink what SQLite writes for a backoff change (one small row instead of the 68 KB envelope), but most writers also bump the store's `revision`, which lives in the envelope, and a claim or settlement also changes the message's `placement`, so its mailbox row is rewritten as well. At the largest known real store (1.2 MB) a write costs about 10 ms CPU.

**Decisions.**

- **What would justify a change?**
  - **Revisit when a real store passes 8 MB, or the stall log attributes event-loop stalls over 50 ms to mail writes (recommended).**
    - Pros: at 7.9 MB a write measured 25–33 ms CPU and an inject claim 15–23 ms, the first size at which a delivered message (claim, request record, settlement: three writes) costs more than a frame budget per write; the largest known store is a sixth of that.
    - Cons: needs task 1's evidence first.
  - **Change it now.**
    - Pros: finishes the report's fix.
    - Cons: a migration and every pending-inject reader changes, for no measured gain, because the whole-store load and serialise stay.
- **What to build once it is justified?**
  - **Row writes: each writer changes only its mailbox row and the inject entries it touches, under the existing lease (recommended).**
    - Pros: removes the cost the measurement found, as `updateStoreRow` did for the prompt queue (5100 (retired; see git history)); pending injects as their own collection falls out of it.
    - Cons: every one of the 24 load-and-save sites changes; cross-mailbox writers (`claimAgentMailWorkerStart`, `moveClosedCoordinatorMail`, budget resets) still need a multi-row write; idempotency and counterparts rows must stay consistent with the mailbox row in one transaction.
  - **Pending injects as their own collection only, as the report proposed.**
    - Pros: a smaller migration.
    - Cons: the measured cost does not move (see Investigation).

### 3. Mailbox list without message bodies

**Problem.** The list reads whole mailbox rows, bodies included, and the read model behind it keeps every body in memory.

**Context.** `listAgentMailboxes` runs on `store.snapshot()` (`apps/backend/src/core/storage-agent-mail-directory.ts:835-897`). The snapshot is one frozen read model, rebuilt when the store's revision moves; a rebuild parses only rows whose serialised value changed (`storage-agent-mail-store.ts:367-427`). The same snapshot serves the inbox, status and summary reads, which do need bodies. `mail-presence` lists every mailbox on each pass, and returns early while messaging is off (`apps/backend/src/core/agent-mail-service.ts:384`).

**Investigation.** Re-checked: still true. Measured: a list on an unchanged store costs 0.8–1.7 ms CPU at every size up to 28.9 MB. A list after a send, which rebuilds the read model with one changed row, takes 4–11 ms at 1.85 MB, 8–11 ms at 7.9 MB and 16–19 ms at 28.9 MB of wall time. That rebuild is not body parsing (only the changed mailbox row is parsed); it is sorting every row, assembling the envelope and `normalizeStore` walking every message (`storage-agent-mail-store.ts:397-417`). A first list after a restart parses everything: 5–8 ms CPU at 1.85 MB, 39–50 ms at 28.9 MB. The read model holds 3.0–3.1 times the serialised store on the heap (5.4–5.5 MB for 1.85 MB, 24.3 MB for 7.9 MB, 48 MB for 15.4 MB, 90–91 MB for 28.9 MB), because JavaScriptCore's `JSON.parse` stores these strings as UTF-16 and each message is an object; the database's row cache holds the serialised rows (about the store's size) besides. Bodies are 58% of the serialised bytes at 1.85 MB and 71% at 28.9 MB (1.8 KB bodies).

**Decisions.**

- **What would justify a change?**
  - **Revisit when a real store passes 8 MB, where the read model holds about 24 MB (recommended).**
    - Pros: the list itself is cheap at every size; only memory grows with the store, and at today's known size it is about 4 MB.
    - Cons: needs task 1's evidence first.
  - **Change it now.**
    - Pros: the list never touches bodies.
    - Cons: a stored-format change touching every mail reader and writer, for about 4 MB at the known real size.
- **What to build once it is justified?**
  - **Bodies in their own rows, read by key for the inbox and message reads, with the read model keeping metadata only (recommended).**
    - Pros: removes most of the retained memory (bodies are most of the bytes, and UTF-16 doubles them); combines with task 2's row writes, which would write a new body row once.
    - Cons: a stored-format change with a migration; every reader that needs a body (inbox, message read, conversation, inject dispatch) reads its row.
  - **Keep the format and make the rebuild skip unchanged mailboxes in `normalizeStore`.**
    - Pros: no migration; cuts the after-write list time, which is the part that grows with the number of messages.
    - Cons: does nothing for retained memory.

## Assumptions and decisions

### Tasks 2 and 3: not built (report part 0560)

The report recommended building either task only after a measurement showed it mattered. The measurement (Current state) shows that the list is cheap at every size and that a write's cost comes from loading and serialising the whole store, which the report's option for task 2 does not remove. Neither was built; the thresholds above say when to revisit and what to build then.

### Measurement method

A benchmark script on synthetic data rather than an isolated `dev:test` profile: the costs are inside the storage layer, a script reaches store sizes up to the bound in seconds, and no provider turn or UI is involved. The script's fixture is the one 0741's benches use (100 environments × 6 native tabs, 600 mailboxes). Bodies are 1.8 KB ASCII; real bodies vary, and non-ASCII bodies would cost the same on the heap (UTF-16 either way) but more in the serialised rows.

## Current state

Measured 2026-11-05 on an Intel Core Ultra 9 285H (16 CPUs), Linux, Bun 1.4.4, at a host load average of 46 to 57 (other builds), five runs of 20 iterations:

```
mise exec -- bun --expose-gc apps/backend/scripts/agent-mail-store-size-bench.ts --iterations 20
```

Each mailbox holds the same number of acknowledged messages and one pending inject (600 in all, half of them with busy backoff). CPU milliseconds per call, range over the runs; list-after-write is wall time.

| Store (serialised) | Messages per mailbox | Load | Send | Inject claim | Backoff reset | List, unchanged | List after write (wall) | First list after restart | Read model retained |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1.85 MB | 1 | 2.8–4.1 | 9.6–14.4 | 4.7–7.0 | 4.1–8.3 | 1.1–1.6 | 3.8–10.8 | 5.1–7.7 | 5.4–5.5 MB |
| 7.9 MB | 5 | 9.2–12.8 | 25–33 | 15–23 | 17–20 | 0.8–1.7 | 8.4–11.4 | 12–18 | 24.3 MB |
| 15.4 MB | 10 | 19–22 | 38–50 | 25–38 | 24–29 | 1.2–1.4 | 14–26 | 27–36 | 48–49 MB |
| 28.9 MB | 19 | 31–54 | 67–79 | 42–53 | 44–53 | 1.0–1.6 | 16–19 | 39–50 | 90–91 MB |

One run's 1.85 MB retained reading came out at 0.3 MB, an accounting lag the script now discards (it takes the largest reading after the first cycle). Wall times are noisy at this load; the CPU figures agree across runs to within about a third.

## Constraints and rationale

Stored-format changes follow the migration rules in `AGENTS.md` ("Storage rules": one migration in `storage-record-upgrades.ts`, not a reader upgrade on every load) and need tests for old rows. Queue and cache bounds apply, per the efficiency report's invariants (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`): the 2,000-entry pending-inject cap and the 32 MiB store bound must hold across any split.

## Needs verification

- Mail writes per minute in a busy coordinator session; the inject path writes three times per delivered message.

## Related

- [0741 backend responsiveness under load](0741-backend-responsiveness-under-load.md): tasks 3 (the first real size) and 5 (the read model).
- to-do 1202 efficiency follow-ups, task 2 (retired 2026-11-10).
- 5100 prompt queue row writes (done 2026-11-05, deleted 2026-11-06; see git history): the row-write pattern task 2 recommends.
- 6144 per-store sizes (retired on 2026-11-10; see [storage.md](../../architecture/storage.md)).
- Efficiency report, E (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`), ST-9.
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, a real host's agent mail store size and write rate) moved there on 2026-11-10.

## Replaces

Efficiency report part `0560-st-9-agent-mail-store-remainder.md`, deleted 2026-11-05.
