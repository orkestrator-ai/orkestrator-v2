# Fleet ticket sync: follow-ups

## Task analysis

Analysed 2026-11-03 against main at 7b48c23fb, on the branch that added
Kanban sync between a command node and its leaves
([tickets.md](../../architecture/tickets.md#sync-across-machines)). Tasks 2
to 7 were done on 2026-11-09 against main at c6de4733c (see
[Assumptions and decisions](#assumptions-and-decisions)).

### Tasks

1. **Live qualification over two real backends**: open.
2. **Adopt a leaf's tickets from before sync**: done.
3. **Images on synced tickets**: done (live check over a real link with task 1).
4. **A view of sync conflicts, and a "synced from" mark on leaf boards**: done.
5. **A second copy of a repository on one leaf**: done.
6. **Column order across machines**: done.
7. **Split the sync methods out of `KanbanRepository`**: done.
8. **Launches that wait for a disconnected node (opt-in)**: open (depends on 1).

### 1. Live qualification over two real backends

**Problem.** Sync, remote ticket tools and remote builds are covered only over
in-process links (`nodes/node-ticket-sync.test.ts`,
`coordinator-node-tickets.test.ts`), never over a real gateway, a real event
stream and a real disconnect.

**Context.** The build ran with no second machine and was told not to touch
the real fleet. `dev:test` starts one profile; a fleet needs two profiles, one
attached to the other.

**Investigation.** `TestNodeNetwork` (`nodes/node-network-test-support.ts`)
runs the real node commands behind a fake `fetch`, but registers only
`registerNodeCommands`, so it cannot yet drive the ticket-sync commands. The
outbox announcement travels on the leaf's event stream like
`node-outbox-ready`.

**Decisions.**

- **How to qualify?**
  - **Two `dev:test` profiles, one attached to the other (recommended).** Create a ticket on the command profile, check the leaf's board, edit on the leaf, stop the leaf, edit both, restart it, check the conflict comment and the board's sync line; start a pipeline with `nodeId`.
    - Pros: real links, streams and reconnects; also checks the UI.
    - Cons: needs a fixture repository with a remote both profiles clone; billed turns if the pipeline is allowed to run (cancel it after it links).
  - **Extend `TestNodeNetwork` with the ticket-sync commands.**
    - Pros: deterministic, runs in `mise run test`.
    - Cons: still a fake `fetch`; no UI.

### 2. Adopt a leaf's tickets from before sync

**Problem.** Tickets a leaf had before its command node first synced the
project stay on the leaf only, so the two boards stay apart for older work.

**Context.** Decided this way on purpose: adopting every old ticket on first
sync would copy tickets the user may have duplicated by hand (the 15 relayed
tasks of the session that prompted this work) and could not be undone.

**Investigation.** A leaf-local ticket has no `sync.replica`. Adoption is the
same `create` change a new leaf ticket queues (`stampTicketChange`), so an
explicit action only needs to queue it for chosen tickets.

**Decisions.**

- **How to adopt?**
  - **An explicit "Share with the command node" action on the leaf's board, per ticket or for all (recommended).**
    - Pros: the user decides; reuses the create path; nothing duplicated silently.
    - Cons: one more control.
  - **Adopt everything on first sync.**
    - Pros: no UI.
    - Cons: duplicates, and no undo.

### 3. Images on synced tickets

**Problem.** Images attached on one machine are not on the other; a synced
ticket's image list differs per machine.

**Context.** Each machine stores image bytes as files (`kanban-images/`).
A build's ticket snapshot carries images sent by the launcher, so pipelines do
not depend on this.

**Investigation.** Snapshots and the outbox carry no image fields; `images` on
a replica is the leaf's own list.

**Decisions.**

- **What to sync?**
  - **References, with bytes fetched on demand over the link (recommended).** Sync `{ id, filename, createdAt, nodeId }`; a machine without the bytes reads them with a bounded node-link read.
    - Pros: small sync batches; images visible everywhere.
    - Cons: an offline machine's images are unavailable; a new read command.
  - **Bytes in the sync batches.**
    - Pros: always available.
    - Cons: large batches and outbox bytes against the 32 MiB bound.

### 4. A view of sync conflicts, and a "synced from" mark on leaf boards

**Problem.** Conflicts are shown as a count on the board's sync line and as a
comment on each ticket; there is no list to review or dismiss, and a leaf's
board does not mark which tickets are copies.

**Context.** `get_ticket_sync_status` returns the latest 20 conflicts; the
store keeps 200.

**Investigation.** A replica row has `sync.replica.controllerId`; the leaf can
name its command node from its attachments.

**Decisions.**

- **Where to show them?**
  - **A popover from the sync line listing conflicts with a link to each ticket, and a small mark on replica cards (recommended).**
    - Pros: minimal; uses data already returned.
    - Cons: dismissal needs a new write.
  - **Leave comments as the only record.**
    - Pros: nothing to build.
    - Cons: easy to miss.

### 5. A second copy of a repository on one leaf

**Problem.** A command node project pairs with the first leaf project of the
same repository; a second copy on the same leaf is not synced.

**Context.** Ticket ids are global on a machine (`getKanbanTask(id)`), so one
ticket cannot be two rows on one leaf. `applyTicketSync` refuses to sync one
command node project into two leaf projects.

**Investigation.** The pairing is in `NodeTicketSync.pairs`.

**Decisions.**

- **Keep one copy per leaf?**
  - **Keep it, and say which copy syncs in the sync line's tooltip (recommended).**
    - Pros: simple and unambiguous.
    - Cons: the other copy's board stays local.
  - **Let the user choose the synced copy.**
    - Pros: control.
    - Cons: a setting for a rare case.

### 6. Column order across machines

**Problem.** Status syncs but the order within a column does not; each
machine keeps its own order.

**Context.** `order` changes on every status move and drag; syncing it would
make most drags conflict.

**Investigation.** Not stamped by `stampTicketChange`.

**Decisions.**

- **Sync order?**
  - **Leave it per machine (recommended).**
    - Pros: no conflicts from drags.
    - Cons: boards can order a column differently.
  - **Sync it as a field.**
    - Pros: identical boards.
    - Cons: conflict noise.

### 7. Split the sync methods out of `KanbanRepository`

**Problem.** `storage-kanban.ts` is about 1,900 lines with the sync methods,
near the 2,000-line limit.

**Context.** The methods need the Kanban lease and the private commit, and the
writer-guard analysis follows store writes through repository classes.

**Investigation.** The pure rules are already in `storage-kanban-sync.ts`.

**Decisions.**

- **How to split?**
  - **A collaborator that takes a shared context with the lease and commit (recommended),** registered with the writer-guard analysis.
    - Pros: follows "Splitting large classes" in AGENTS.md.
    - Cons: touches the guard test's repository list.
  - **Leave it until the file grows.**
    - Pros: no churn now.
    - Cons: the next feature crosses the limit.

### 8. Launches that wait for a disconnected node (opt-in)

**Problem.** Launches, builds and reviews on a disconnected node are refused,
so a coordinator has to retry after the node returns.

**Context.** Decided as fail fast: a queued launch would start from a stale
base commit hours later, and an outcome lost to a disconnect could not be
resolved without risking a second run.

**Investigation.** The coordinator already gets a status wake when a node's
workflow changes; a reconnect could wake it too.

**Decisions.**

- **What to add?**
  - **A wake when a node the coordinator tried reconnects, with no queued launch (recommended).**
    - Pros: no stale launches; the coordinator retries with a fresh base.
    - Cons: a retry turn.
  - **A durable "launch when reconnected" queue.**
    - Pros: hands-off.
    - Cons: stale bases, duplicate risk, and a visible queue state to build.

## Assumptions and decisions

### Task 2: sharing a leaf's older tickets

- **Chosen:** the recommended explicit action. The leaf board's sync line
  offers "Share N older tickets with <command node>" and each such card's
  menu "Share with <command node>"; both call
  `share_tickets_with_command_node` (`taskIds`, or all), which queues the
  same `create` a new leaf ticket queues (`shareTicket` in
  `storage-kanban-sync.ts`) and marks the row a pending copy. Nothing is
  adopted on first sync.
- **Eligible tickets** are the board's rows with no `sync.replica` (made
  before sync, or kept when a command node detached). A board no command node
  syncs refuses with a message. Sharing again sends nothing twice.
- **Leaf status** (`get_ticket_sync_leaf_status`, `workspace` access) gives
  the board what it needs: the command nodes, their names from the leaf's
  attachments, the changes waiting and how many tickets Share would send.

### Task 3: images on synced tickets

- **Chosen:** the recommended references with bytes over the link, with one
  addition the link's direction forced: a leaf never reaches its command
  node, so it cannot read an image on demand. It records a want
  (`LeafTicketImageWants`, in memory, bounded, 20 s timeout), announces it with
  `ticket-sync-outbox-ready`, and the command node delivers it on that
  collection (`wantedImages` in the collect result, then
  `put_ticket_image`). A command node reads a leaf's image with
  `read_ticket_image`. Both sides keep the copy, so an image crosses a link
  once. Bytes never travel in sync batches or the outbox.
- **Older peers:** a leaf queues `add-image`/`delete-image` (and images on a
  creation) only for a command node that declared the `images` feature in
  `collect_ticket_sync_outbox` (`features`, recorded in the sync store). An
  older command node's parser would refuse those operations and wedge the
  outbox. A snapshot without `images` leaves a leaf's list alone. Images
  attached on a leaf before its command node declared the feature stay on the
  leaf until a later change; no catch-up runs.
- **Removal:** a leaf's own image the board never listed is kept (it may
  predate image sync); one the board listed (`synced`) and then dropped is
  removed. A reference the board drops is removed with any kept copy.
- **No new domain version:** five new commands and optional fields; the
  contract manifest and argument schemas were regenerated.

### Task 4: the conflict list and the synced-from mark

- **Chosen:** a list opened from the sync line's conflict count, each entry
  opening its ticket or being dismissed, plus Dismiss all. It is a dialog,
  not a popover: the web app has no popover primitive, and adding
  `@radix-ui/react-popover` would change the lockfiles for one list.
- **Conflict ids:** new records get an id; records written before have one
  derived from their content (`ticketSyncConflictId`), so they can be
  dismissed too. `dismiss_ticket_sync_conflicts` removes records from the list
  only; the comment on the ticket stays. Status now also returns the total
  (`conflictCount`), since it lists only the latest 20.
- **Mark:** a confirmed copy's card shows a link icon with the command node's
  name (from the leaf status); a pending copy shows none until confirmed.

### Task 5: a second copy of a repository on one leaf

- **Chosen:** the recommended "keep one copy per leaf and say which syncs".
  The command node's node tooltip names the leaf project that syncs and how
  many other copies keep their own boards (`projectName`, `otherCopies` on
  `TicketSyncNodeState`). On the leaf, the second copy's sync line says it is
  not synced and names the copy that is (`syncedCopy` in the leaf status).

### Task 6: column order

- **Chosen:** the recommended "leave it per machine". No code change was
  needed; a test pins that a drag on either machine queues and sends nothing
  and that a later change keeps the leaf's own order. Documented in
  [tickets.md](../../architecture/tickets.md#sync-across-machines).

### Task 7: splitting the sync methods out

- **Chosen:** the recommended collaborator. `KanbanBoardStore`
  (`storage-kanban-board.ts`) holds the Kanban lease, its reads and the commit
  that stamps changes for sync; `KanbanRepository` and the new
  `KanbanSyncRepository` (`storage-kanban-sync-repository.ts`) share one
  instance. Callers reach sync as `storage.ticketSync` (a `Pick` area, like
  `storage.kanban`), and both classes are in the writer-guard analysis's
  repository list. `storage-kanban.ts` went from 2,022 to about 1,370 lines.

## Current state

Built: the sync core (both directions, conflicts, tombstones, cursors,
epochs, outbox bounds), coordinator ticket tools and `start_build_pipeline`
with `nodeId`, the board's sync line and "runs on" chip, the `ticket-sync`
capability with the older-leaf messages, and the docs. Since 2026-11-09 also:
Share for a leaf's older tickets, image references with bytes read over the
link, the conflict list with dismissal, the leaf's sync line and synced-from
mark, the second-copy messages, and `KanbanSyncRepository`. Tasks 2 to 7 are
covered by `nodes/node-ticket-sync-followups.test.ts` (two real stores over the
in-process link), `nodes/node-ticket-images.test.ts`, `ticket-sync.test.ts`
and `TicketSyncStrip.test.tsx`.

## Outstanding work

- Task 1 (live qualification over two real backends), which should now also
  exercise Share, an image read in each direction and the conflict list.
- Task 8.

## Needs verification

Task 1: nothing here has run over a real node link, including the image reads
and deliveries of task 3.

## Related

- [tickets.md](../../architecture/tickets.md#sync-across-machines)
- [command-nodes.md](../../architecture/command-nodes.md#tickets-across-nodes)
- [coordinator.md](../../architecture/coordinator.md#tickets-on-other-machines)
