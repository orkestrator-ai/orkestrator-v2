# Agent mail: pending injects and mailbox lists still sit on the whole store

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Pending injects as their own collection**: stop keeping them in the store's envelope document. Status: open.
2. **Mailbox list without message bodies**: serve the list without holding bodies. Status: open.

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
