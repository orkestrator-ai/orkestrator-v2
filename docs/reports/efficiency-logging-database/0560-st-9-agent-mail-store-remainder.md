# Agent mail: pending injects and mailbox lists still sit on the whole store

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`. Re-checked and measured 2026-11-05 against `main` at `cbe0f9a5b`; see Outcome.

### Tasks

1. **Pending injects as their own collection**: stop keeping them in the store's envelope document. Status: not built on measured numbers; moved to [6760](../../todo/cross-cutting/6760-agent-mail-store-split-thresholds.md) task 2.
2. **Mailbox list without message bodies**: serve the list without holding bodies. Status: not built on measured numbers; moved to [6760](../../todo/cross-cutting/6760-agent-mail-store-split-thresholds.md) task 3.

### 1. Pending injects as their own collection

**Problem.** Pending injects live in the envelope, so changing one rewrites the envelope, and any writer goes through a whole-store load.

**Context.** 1202 task 2 lists this as not re-checked. This re-check found it still true.

**Investigation.** The layout's collections are `mailboxes`, `idempotency` and `counterparts` (`apps/backend/src/core/storage-stores.ts:75`), so `pendingInject` is not one of them. It is a plain array on the store (`apps/backend/src/core/storage-agent-mail-store.ts:77`, `:138`), rebuilt during normalisation (`:218-232`) and scanned by `apps/backend/src/core/storage-agent-mail-injects.ts:72`. Writers use `load` and `save` inside `enqueue` (`apps/backend/src/core/storage-agent-mail-directory.ts:560-561`, `:660`).

**Decisions.**

- **Move it now?**
  - **Only after a measurement shows mail writes matter (recommended).**
    - Pros: reads already avoid the cost; moving it is a stored-format change with old rows to migrate.
    - Cons: a write still loads the store.
  - **Move it now.**
    - Pros: finishes the report's fix.
    - Cons: a migration, and every reader of `store.pendingInject` must change.

### 2. Mailbox list without message bodies

**Problem.** The list reads whole mailbox rows, bodies included.

**Context.** A row is one mailbox with its messages, up to the 32 MiB store bound (`AGENT_MAIL_MAX_STORE_BYTES`, `packages/protocol/src/agent-mail.ts:11`).

**Investigation.** `listAgentMailboxes` runs on `store.snapshot()` (`storage-agent-mail-directory.ts:797-812`). The snapshot only re-parses rows whose serialised value changed, and an unchanged store costs one revision query (`storage-agent-mail-store.ts:356-422`). So the remaining cost is one changed mailbox's parse, plus the retained parsed bodies.

**Decisions.**

- **Split the row?**
  - **Leave it until a measurement shows the retained bodies or the changed-row parse matter (recommended).**
    - Pros: the frozen read model has removed the per-poll parse this finding described.
    - Cons: bodies stay in memory in the read model.
  - **Store message bodies in their own rows.**
    - Pros: the list never touches bodies.
    - Cons: a stored-format change touching every mail reader and writer.

## Current state

- Presence returns early while messaging is off (`apps/backend/src/core/agent-mail-service.ts:380`).
- Reads use a frozen read model rebuilt per revision (6953e8df7, #1423).
- The second serialisation for measuring is gone: `save` measures the rows the write produces (`storage-agent-mail-store.ts:431-436`; #1423).

## Constraints and rationale

Stored format changes need the migration rules in `AGENTS.md`. Cache and buffer bounds apply, per the report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep).

## Needs verification

- Mail store sizes and write rates on real hosts. `storage-read` bytes for `mail-presence` in the recurring-work metrics can confirm the read side.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 2

## Outcome

Checked back against the code and measured on 2026-11-05, base `cbe0f9a5b`, with `apps/backend/scripts/agent-mail-store-size-bench.ts` on synthetic stores (600 mailboxes, 1.8 KB bodies) at 1.85, 7.9, 15.4 and 28.9 MB; no provider turn. Full numbers and thresholds: [6760](../../todo/cross-cutting/6760-agent-mail-store-split-thresholds.md).

| Item | Outcome | Code, evidence or to-do |
| --- | --- | --- |
| 1. Pending injects as their own collection | Still true; not built, as recommended | `pendingInject` is still an envelope field (`storage-agent-mail-store.ts:78-108`) and the collections are unchanged (`storage-stores.ts:79`). A write's cost is the whole-store load and the serialisation of every row: a backoff reset, which changes only pending-inject entries, cost the same as a send (4–8 ms CPU at 1.85 MB, 44–53 ms at 28.9 MB). Moving the queue would leave both. Threshold (a real store over 8 MB, or mail-write stalls over 50 ms) and the option to build then (row writes): 6760 task 2. |
| 2. Mailbox list without message bodies | Still true; not built, as recommended | The list is 0.8–1.7 ms CPU at every size; after a write, 4–19 ms wall, spent re-assembling the store rather than parsing bodies. The read model holds 3.0–3.1 times the serialised store (5.4 MB at 1.85 MB, 90 MB at 28.9 MB); bodies are 58–71% of the bytes. Threshold (a real store over 8 MB) and the option to build then (bodies in their own rows): 6760 task 3. |
| Current state: presence returns early while messaging is off | Holds | `agent-mail-service.ts:384`. |
| Current state: frozen read model, single serialisation | Holds | `snapshot` (`storage-agent-mail-store.ts:367-427`), `save` (`:429-443`). |
| Needs verification: real store sizes and write rates; `storage-read` bytes for `mail-presence` | Moved to a to-do | The metric charges bytes only on a fetch from SQLite: 0 after a send in the same process, the whole store after another connection's write, so it cannot show the list's cost on a real host. Real sizes: 6760 task 1. |
