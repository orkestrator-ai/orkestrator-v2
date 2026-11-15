# What project removal still leaves behind

Follow-up from 5820 (retired 2026-11-15), which made removing a project
delete its tickets, ticket images, labels, notes and feature plans, and a
deleted pipeline's completion comment records. Two things it found are not
covered: rows that projects removed before that change left behind, and a
leaf whose queued ticket changes name a command node project that was
removed. Both are agent work.

## Task analysis

Analysed 2026-11-15 against `main` at `49bb327cc`.

### Tasks

1. **Rows left by earlier removals**: decide whether, and how, to delete Kanban, notes, plans, labels and completion comment records that name no project here. Status: open.
2. **Leaf changes for a removed command node project**: stop them stalling every later change from that leaf. Status: open.

### 1. Rows left by earlier removals

**Problem.** Until 5820, removing a project left its tickets, image files,
label catalogue, notes and feature plans in the database, and deleting a
pipeline left its Linear and GitHub completion comment records. The new
removal path deletes only what the removed project still has at the moment it
is removed, so a machine that removed projects before the change keeps those
rows, with nothing able to reach them.

**Context.** `KanbanRepository.deleteProjectContent` (`storage-kanban.ts`)
deletes one project's rows; `deleteCompletionCommentsForPipelines` deletes
records by pipeline id. Project ids are minted by `createProject`
(`randomUUID()`), so a row naming an id that is not in the projects store can
never be shown again. Deleting user content must scrub
([storage](../../architecture/storage.md#durability-and-deletion)).

**Investigation.** Not measured on a real install. These stores are small (on the
machine the E3 report sampled they held about 130 rows and 0.6 MB), so this
is about privacy, not size. The risk of a sweep is a
projects store that reads as empty or partial (an unreadable row, a damaged
store): a sweep that trusted that read would delete every project's tickets.

**Decisions.**

- **How to remove them?**
  - **A one-time sweep at startup that deletes rows naming no stored project, only after a strict, complete read of the projects store (recommended).**
    - Pros: cleans every machine once with no user step; the strict read is
      the same guard the deleted-environment reconcile uses
      ([change tracking](../../architecture/change-tracking.md)).
    - Cons: one more startup pass; a mistake in the guard deletes live
      tickets, so it needs tests for an unreadable and an empty projects store.
  - **Leave them.**
    - Pros: no risk to live data.
    - Cons: user content the user removed stays on disk indefinitely.
  - **A manual "clean up" action in Settings.**
    - Pros: the user sees what goes.
    - Cons: a control almost nobody would find, for data nobody can see.

### 2. Leaf changes for a removed command node project

**Problem.** When a command node's project is removed, a leaf keeps its own
project and its copies of that board's tickets (removal is per machine). A
change the user then makes to such a copy is queued for the command node
under the removed project's id. The command node refuses changes for a
project it does not have and leaves them queued (`NodeTicketSync`,
`node-ticket-sync.ts`: "Ticket changes for an unknown project remain queued
on the leaf. Restore the project to resume sync."), and, because the outbox
is applied in order, every later change from that leaf, for any project,
waits behind them. Re-adding the repository on the command node mints a new
project id, so "restore the project" cannot clear it.

**Context.** The rule is older than 5820: any command node project removal
could reach it. 5820 only made removal delete the board, which makes the case
easier to meet. The leaf copies carry `sync.replica.sourceProjectId`; the
command node knows which of its projects exist (`localProjects`).

**Investigation.** Traced in code on 2026-11-15, not reproduced in a test.
`applyTicketSyncOps` is given only the changes before the first unknown
project, and the collection stops there with state `error`.

**Decisions.**

- **What should a change for a removed project do?**
  - **The command node acknowledges and drops it, records a content-free conflict for the leaf's sync line, and tells the leaf that project is gone so its copies become its own, as Detaching does (recommended).**
    - Pros: one removed project cannot stall a leaf's other projects; the
      leaf's copies stop pretending to sync.
    - Cons: the dropped changes are lost to the board, which no longer
      exists anyway; a new leaf command or a field in an existing reply.
  - **Skip it and apply the rest, keeping it queued.**
    - Pros: nothing is dropped.
    - Cons: breaks the in-order outbox contract; the queue never drains.
  - **Keep today's behaviour.**
    - Pros: no change.
    - Cons: the leaf's sync stays stalled until someone clears its outbox by
      hand.

## Related

- 5820 (retired): the removal rules are in
  [tickets.md](../../architecture/tickets.md#sync-across-machines) and
  [storage.md](../../architecture/storage.md#code-layout).
- [5821](5821-ledger-retention-live-evidence.md), the rest of the same
  efficiency batch.
