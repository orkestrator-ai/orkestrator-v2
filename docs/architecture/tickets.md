# Tickets: kinds, sections and checkable acceptance criteria

A Kanban ticket has a **kind**, **typed optional sections** stored as JSON, and
two plain-text **mirrors** that every older reader keeps using. Acceptance
criteria are items that a Build pipeline's Verify step marks passed, failed or
not checked, with evidence. The design options were weighed in to-do 0742
(retired 2026-11-10).

Code: `packages/protocol/src/ticket-sections.ts` (schema, markdown, mirrors,
migration), `apps/backend/src/core/storage-kanban.ts` (reads and writes),
`apps/web/src/components/tickets/` (tiles).

## Kinds

| Kind | Who writes it | What it says |
| --- | --- | --- |
| `feature` (default) | The user, or a coordinator filing board work | *What* to build: summary, acceptance criteria, out of scope. |
| `work-brief` | A coordinator, for one worker | *How* to work: problem, context, decisions, constraints, delivery, reporting. |

A ticket without a stored kind is a feature ticket. Follow-up and steer
messages to a running worker stay agent mail, not a ticket kind (see the design
record).

Standing project rules (report format, the checks every change runs, the PR
flow, safety rules) belong in the project's `AGENTS.md` `## Orkestrator`
section. Tickets carry only what differs for this piece of work; the tool
descriptions say so.

A constraint that limits which files the work may edit never covers updating
references to files the work deletes, moves or renames, or descriptions (a
status scheme, a layout example) the work makes untrue. The sections guidance
in the ticket tools tells ticket writers to say so, and every build, rework
and address prompt tells the worker to repair such references and
descriptions anyway (`REFERENCE_UPDATE_RULE` in `build-pipeline-prompts.ts`;
root `AGENTS.md`, "Keep references current"). Edit bans had left `AGENTS.md`
naming deleted to-dos and an outdated status rule, with the work reported
incomplete.

## Sections

All optional. In render order:

| Key | Heading | Type | Notes |
| --- | --- | --- | --- |
| `summary` | (none) | text | Text before the first `##` heading. |
| `problem` | Problem | text | |
| `context` | Context | text | Aliases: Background, Why, Evidence, Where to start. |
| `decisions` | Decisions | text | Choices already made. |
| `constraints` | Constraints | text | |
| `acceptanceCriteria` | Acceptance criteria | items | `{ id, text, check? }`. Aliases: Done when, Definition of done. |
| `checks` | Checks | list of strings | Standard commands, kept out of the criteria. |
| `delivery` | Delivery | `{ policy?, note? }` | `policy`: `commit-only`, `push-no-pr`, `open-pr`; none means `open-pr`. A build follows it ([Delivery](#delivery)). |
| `reporting` | Reporting | text | Report fields beyond the project's standard report. |
| `outOfScope` | Out of scope | text | Aliases: Non-goals. |
| `custom` | (its own title) | `{ title, body }[]` | Any `##` heading that names no known section. |
| `notes` | Notes | text | |

## Markdown form and round trip

Editing is text. The editor shows the whole ticket as markdown: the summary,
then one `## Heading` per section. Rules:

- Only `##` lines outside code fences start a section. `#`, `###` and deeper
  headings stay inside the section they are in.
- Headings match case-insensitively, with trailing `:` and `**` ignored, against
  each section's heading and aliases. An alias is rewritten to the canonical
  heading when the ticket is next saved from structured input.
- An unknown heading becomes a custom section with that title, so freeform text
  always survives.
- Acceptance criteria and checks are list items (`-`, `*`, `+`, `1.`, with an
  optional `[ ]`/`[x]`). Lines that are not top-level items continue the item
  above, with the marker's indent removed. A body with no list markers is split
  into one item per paragraph. Text before the first item is an item too.
- Delivery: a first line `Policy: <id or label>` sets the policy; the rest is
  the note. An unknown policy stays in the note.
- A repeated known heading is appended to the earlier one.

`render(parse(text))` is byte-identical for text in canonical form, and stored
sections are always a fixed point of `parse(render(...))`
(`canonicalTicketSections`). Tests: `packages/protocol/src/ticket-sections.test.ts`.

## Criteria ids and results

Each criterion has an id (`ac-1`, `ac-2`, …). When text is parsed against the
previous criteria, an item whose text is unchanged keeps its id and its result.
Any other item is new: a fresh id that was never used on the ticket, and no
result, because changing a criterion's text invalidates its result.

A result (`check`) is `{ status, evidence, checkedAt, source, pipelineId? }`.
`status` is `passed`, `failed` or `not-checked`; no `check` means Verify has not
judged it yet. Results are never written into the markdown, so editing text
cannot forge one. One exception: ticking a box by hand (`- [x]`) on an item with
no result records a `manual` pass.

## Mirrors and migration

Every ticket keeps `description` (markdown of every section except the
criteria) and `acceptanceCriteria` (the criteria as a list). Pipeline prompts,
Linear and GitHub sync, the CLI, and older backends sharing the data directory
read these.

- **Structured writes** (`sections` or `markdown`) render both mirrors from the
  sections.
- **Text-only writes** (`description` and/or `acceptanceCriteria`, perhaps with
  `kind`) are stored exactly as written, and the sections are derived from them.
  This is how every writer that predates sections changes a ticket.
- **Legacy rows** (no sections) are migrated on read: sections are derived from
  the text, and nothing is written back until the ticket next changes. A legacy
  `- [x]` becomes a manual pass dated at the ticket's creation, so repeated
  reads return the same row, and an edit that keeps the criterion keeps that
  date.
- `sectionsBasis` is a fingerprint of the mirrors the sections were written
  with. If an older writer changes a mirror, the fingerprint no longer matches
  and the sections are rebuilt from the text, keeping the results of criteria
  whose text did not change.

## Labels

A ticket carries label names (`labels`), in the order they were added; a
ticket with none has no field. Each project also has a label catalogue (store
`kanban-labels`, one row per project): labels created ahead of use, with an
optional colour (`#rrggbb`) and description. Code:
`packages/protocol/src/ticket-labels.ts` (rules and limits),
`apps/backend/src/core/storage-kanban-labels.ts` (the catalogue) and
`KanbanRepository.setKanbanTaskLabel`/`getKanbanLabels`/`createKanbanLabel`.

- **Names.** One line, 1 to 50 characters, whitespace runs collapsed to one
  space. They match ignoring case, and a name the project already uses (in
  its catalogue first, then on its tickets) keeps that spelling: adding `BUG`
  where `bug` exists adds `bug`. A ticket holds at most 20; a catalogue 200.
- **What a project offers** (`ticket.labels`, `list_ticket_labels`) is the
  catalogue in creation order, then every other name its tickets carry,
  alphabetically, each with `ticketCount`. A label used on a ticket but never
  created is listed too, without colour; it disappears once no ticket carries
  it.
- **Creating** a name that exists (any case) is not an error: it reports
  `created: false` and takes a colour or description the call gives.
- **Adding** a label to a ticket does not require creating it first. Adding
  one a ticket has, or removing one it lacks, changes nothing.
- **Sync.** Labels are part of a ticket's `content` field across machines
  (same revisions and conflicts as the text). New nodes always send the list,
  empty when there are none; content from a node that predates labels has no
  list, and the receiver keeps the labels it has. The catalogue is not synced:
  each machine lists its own catalogue plus the labels on its tickets.

## Tools

`create_ticket` and `update_ticket` (worker agent tools and the coordinator's
Control MCP), the public `ticket.create`/`ticket.update` actions, the CLI
(`--kind`, `--sections-file`) and the `add_kanban_task`/`update_kanban_task`
commands accept `kind` and `sections`. A `sections` update replaces only the
sections it names; an empty value clears one. `description` and
`acceptanceCriteria` are still accepted. Reads return `kind`, the text
mirrors, `criteria` (id, text start, status, evidence; bounded),
`deliveryPolicy` and `labels`.

Labels: `create_ticket` and `update_ticket` take `labels` (update replaces the
list; `[]` clears it), `list_tickets` and `ticket.list` filter by `label`, and
three tools manage them one at a time. Worker agent tools and the Control MCP
(coordinators and operators) call them `list_ticket_labels`,
`create_ticket_label` and `set_ticket_label` (`present: false` removes); the
public actions, and the operator's direct tools named after them, are
`ticket.labels`, `ticket.label.create` and `ticket.label`
(`ticket_labels`, `ticket_label_create`, `ticket_label`). The worker groups
are `orkestrator:tickets.read` (list) and `orkestrator:tickets.write` (create,
set). A command node coordinator's ticket tools also take a
`nodeId` ([Sync across machines](#sync-across-machines)).

## Verify

When a pipeline starts, the backend stores the criteria in the task snapshot
(`acceptanceCriteriaItems`) under the Kanban ticket's own ids, if the ticket's
criteria text still matches the snapshot. Otherwise, and for snapshots written
before this existed, ids are derived from the snapshot text deterministically
(`taskSnapshotCriteria`).

The Verify prompt lists the criteria as JSON and asks for one entry per id. The
verdict schema is `{ complete, rationale, acceptanceCriteria: [{ id, status,
evidence }] }`. The prompt allows `passed` only on evidence the verifier
established itself and requires `not-checked`, never `passed`, for a criterion
it cannot establish here. A verdict in the old two-field shape (a verify turn
started before the upgrade) is still accepted and records no criteria.

A `not-checked` criterion does not by itself fail a run. No later stage can
supply a real device, a live provider or a person, so failing would only loop
until the iterations ran out. The prompt tells Verify to answer `complete: true`
when the change does everything it could establish, and the criterion is flagged
in the pull request and the pipeline's
[Notes step](build-pipeline-view.md#notes) for a person to check.

The backend stores the results on the verify session
(`acceptanceCriteriaResults`, one per snapshot criterion; a skipped criterion is
`not-checked`, an unknown id is dropped), appends the failed criteria to the
feedback the Fix step reads, and writes the results to the Kanban ticket
(`record_kanban_criteria_checks`, best effort, only for criteria whose id and
text still match).

Each check written to the ticket names the code it judged: `commit` is the
HEAD the Verify session's read-only guard held the worktree to for the whole
turn (`validationHeadAtStart`), and `uncommittedChanges: true` says the
worktree also had uncommitted paths then (`verifySessionJudgedCode` in
`build-pipeline-criteria.ts`). Code can change after Verify (Ship's conflict
resolution, a later fix round, the user's own commit), so the ticket view and
`get_ticket` compare that commit with the build environment's HEAD when they
read the ticket and say "the branch has moved since" when it differs
(`criterionCheckBasis` in `ticket-sections.ts`). Nothing is rewritten when
code moves: the record of what passed stays. A deleted or unreachable
environment shows the commit with no comparison. A Verify check with no
commit (recorded before this field, or by a session whose baseline could not
be read) reads as "commit not recorded", never as current; a hand tick judged
no code and shows neither. The graph engine's `update-ticket` system action
records checks without a commit.

## Delivery

The ticket is the source of truth for what a build does once its work is
verified. Build reads the policy at the moment Verify passes, so it can change
while the build runs, and the latest passing Verify is the one that counts,
including after fix rounds. Skipping Verify is treated the same.

| Policy | Label | After Verify passes |
| --- | --- | --- |
| `open-pr` (or none) | Open a PR, don't merge | The PR stage, then conflict resolution if needed. |
| `push-no-pr` | Push, no PR | A push-only Ship; the pipeline completes once origin has the commit. No Multi Review starts on its own: the coordinator is told the branch is pushed and decides what follows. |
| `commit-only` | Commit, don't push | Nothing runs. The pipeline completes and says the commits stayed in the environment, and how many uncommitted paths remain, since no agent turn commits them. |

The ticket's Delivery tile and the Build launcher's Pull request card share a
"When verified" dropdown (`DeliveryPolicySelect`). It offers "Open a PR, don't
merge" and "Push, no PR"; `commit-only` stays valid for text and tools, and
appears only as the current selection of a ticket that has it, so neither
viewing it nor launching changes it. The tile always shows on the ticket dialog,
even with no policy; the pipeline's Ticket node keeps the read-only view of its
snapshot. A launch saves its choice to the ticket (`launch_build_pipeline`), and
a choice equal to the ticket's own writes nothing. The delivery note is kept.
The form's "A feature" option has the same control under Advanced and saves it
on the ticket it creates. Other launchers have no control and use the ticket's
policy: the coordinator's `start_build_pipeline` deliberately has no override
(and is linked to its ticket, so the too-late comment below reaches it too),
and a Features view build creates a ticket with none, which can be set on its
tile while it runs.

**Too late.** Once Verify passes the decision is on the pipeline
(`BuildPipeline.delivery`), and an edit cannot undo it. The ticket still accepts
the edit, for the next build, and says it came too late for this one: a comment
(`KanbanRepository.onDeliveryPolicyChange` hears every writer) and a note under
the tile's dropdown (`pipelineDeliveryTooLateNote`). These warnings apply to
active runs, including legacy PR-stage records without delivery metadata;
completed runs and the policy write accompanying a new launch do not warn.
Restarting from Verify or
earlier clears the decision, so the next pass reads the ticket again. Retrying
or restarting the push or the PR stage itself keeps it.

**No ticket to read.** The pipeline keeps the last policy it saw
(`BuildPipeline.deliveryPolicy`): captured at launch and refreshed on every
change. Deletion durably retains the ticket's final policy before removing its
row, so Verify sees an edit followed by deletion even when the pipeline listener
is queued behind Verify's lock. The ticket lifecycle steps then do nothing
rather than fail the run. A failed read of the board is not a deleted ticket:
launch rejects admission without a captured policy, and a Verify read fails the
stage instead of guessing. A build
from a Linear or GitHub ticket has only this copy: the launch dialog's choice
stays with that pipeline, and its completion comment says how it was delivered.

## Build lifecycle

A ticket linked to a build pipeline moves through the board on its own. The
events and their columns are one table,
`apps/backend/src/core/build-pipeline-kanban-lifecycle.ts`, read by the
pipeline (`build-pipeline-service-supervisor.ts`, `-recovery.ts`) and the graph
`update-ticket` node (`graph-system-ticket.ts`):

| Event | Column | Writer |
| --- | --- | --- |
| Build starts, including a restart | In progress | `startStage("build")`; the supervisor's reactivation after a restart |
| A rework (fix) round | unchanged (In progress) | none |
| Ship finds the pull request open | Review, PR linked | `persistPullRequest` (`pr-raised`) |
| Ship finds the pull request already merged | Done | `persistPullRequest` closes it (below) instead of `pr-raised`'s Review |
| The build completes with Notes (open PR, `commit-only` or `push-no-pr`) | Review | `reconcileTerminalState` (`complete`) |
| The build fails or is cancelled | Backlog | `reconcileTerminalState` (`failed`) |
| The pull request merges | Done | PR monitor, a build ending, startup sweep (below) |
| The pull request closes without merging | Backlog, unless moved by hand since the build | PR monitor (below) |
| The build's environment is deleted before the build finished | Backlog, with a comment | `build-pipeline-kanban-environment-deleted.ts` |
| The build's environment is deleted after its PR merged | Done | the same |

A ticket in Done is never moved by any lifecycle event, a new build or a
restart included: every lifecycle write passes `preserveDoneStatus` (storage
option `lifecycle`), checked under the same mutation lease as the write, so a
writer that read before the monitor closed the ticket cannot reopen it. A move
by the user is kept until the next lifecycle event, which moves the ticket
again. Each lifecycle move records its column on the ticket
(`lifecycleStatus`, local to the machine that wrote it); a status that differs
from it means someone moved the ticket by hand since, which is what a closed
pull request respects. A ticket's PR state, checks and conflicts are not
columns: they are shown on the ticket's Notes tab.

**On another machine.** A build started on a leaf from the command node's
board (`start_build_pipeline` with `nodeId`) runs this same code on the leaf,
against its copy of the ticket. Every column change, comment and pull request
link queues in the leaf's ticket outbox and reaches the command node's board,
and from there every other copy ([Sync across machines](#sync-across-machines)).
The pull request monitor also runs on the leaf, where the environment is, so
merge and close events reach the board the same way. A command node's ticket
built elsewhere links no pull request itself; the leaf reports it as the
ticket's work location (`sync.work`), which the startup sweep reads too.

**Why tickets stuck (2026-11).** Three causes, fixed together:

- Ship or conflict resolution that found the pull request again after it
  merged applied `pr-raised`'s Review without the done check, moving a ticket
  the monitor had just closed back to Review. Its merge was already recorded
  (`prMergeDoneUrl`), so nothing closed it again.
- Deleting an environment removed its pipelines without a terminal event, so
  an unfinished build's ticket stayed In progress, and one whose pull request
  merged later was never closed (the monitor stops with the environment).
- Builds made before ticket sync (2026-11-03), or launched without the ticket
  (prompt environments, a leaf-local ticket), updated no ticket on the command
  node's board at all. The fix cannot reach those; they were moved by hand.

### Merged pull requests close the ticket

A ticket whose linked pull request merged moves to done, from whichever column
it is in. The rule is in `apps/backend/src/core/kanban-merge-closure.ts`, and
every writer applies it through one storage method,
`KanbanRepository.closeKanbanTasksForMergedPullRequests`:

| Writer | When |
| --- | --- |
| PR monitor (`pr-monitor.ts`, the `status` reconciliation step) | It sees the environment's pull request merge, or repairs a merge it recorded before a restart. |
| Build pipeline (`updateKanbanLifecycle`, terminal events) | The build completes, fails, is cancelled or deleted after its Ship opened a pull request that has since merged. Without this the `complete` and `failed` events would move the ticket back to review or backlog. |
| Build pipeline (`persistPullRequest`) | Ship or conflict resolution finds the pull request already merged. |
| Environment deletion (`build-pipeline-kanban-environment-deleted.ts`) | The environment being deleted records its pull request as merged. |
| Startup sweep (`pr-monitor-runtime.ts`, the first sync of each backend process) | A merge recorded on a ticket that never closed it: one an older build left in backlog or review, or one whose environment was deleted before the monitor applied the merge. |

A merge is recorded when the ticket links a pull request in state `merged`;
for a ticket with no linked pull request, when its work location on another
machine (`sync.work`) names one in state `merged`; or, with neither, when its
latest pull-request comment is the monitor's `🎉 PR merged: <url>`. A later
`🔗 PR raised` or `❌ PR closed` comment means other work followed. The sweep
leaves in-progress tickets alone, because a ticket being built again keeps its
earlier pull request until the new build raises one.

The closure happens once per pull request. The ticket records the merged pull
request that closed it (`prMergeDoneUrl`), even if it was already done when the
merge was observed. Recording that merge leaves a done ticket’s order alone.
The marker travels with status in sync snapshots and outbox changes, sharing
its revision and conflict rules. A ticket the user moves back out of
done afterwards stays where they put it, until a different pull request merges.

### Closed pull requests return the ticket

When the PR monitor sees the build's pull request close without merging, it
asks `KanbanRepository.returnKanbanTaskForClosedPullRequest` once, before it
links the closed pull request on the ticket (so a restart does not ask again).
The ticket goes back to the backlog only when it is not done, that pull
request never merged it, and its column is still the one the lifecycle set
(`kanbanTaskReturnsForClosedPullRequest`). A ticket the user moved by hand
since, or one no build ever moved, keeps its place.

## Views

**The ticket view** (`KanbanTaskDialog`, parts in
`apps/web/src/components/kanban/ticket-view/`) is a large modal (72rem, the
top of the modal scale, 90% of the window's height) laid out like the
full-tab Notes page. It has two tabs, **Ticket** and **Notes**, as a tablist.
Each tab has an action bar that sits above its scrolling content, so it stays
visible, and below it a narrow index down the left (from the `@3xl` container
width) and one wide content column on the right; sections never sit side by
side.

- **Ticket**: the bar has Build… (the build launcher, disabled while a build
  of the ticket runs), Edit (the markdown editor, in place) and View Build.
  The index lists the ticket's sections (summary, criteria, the other
  structured sections, Delivery), Images, Comments and activity (the
  lifecycle's comments are the activity) and Pull request. Index entries are
  links that scroll the column.
- **Notes**: the linked build's Notes (`KeyInformationDocument`, single column,
  led by what needs a look), with the Notes headings as its index. The bar
  shows the pull request's state (open, draft, checks running or failed,
  conflicts, ready to merge, merged, closed) from the same readiness rule as
  the environment name and auto-merge, a Merge button enabled only when that
  rule says ready (and confirmed before it merges), and the pipeline's
  Integrate button, which arms auto-merge and launches Resolve for conflicts.
  Nothing merges without a click. The tab is disabled, with the reason shown,
  when the ticket has no build here with Notes; a ticket built on another
  machine says which.

A ticket opened from the Review column with Notes opens on the Notes tab;
every other ticket opens on Ticket (`defaultTicketViewTab`).

`TicketSectionsGrid` renders the sections as tiles in render order for the
pipeline Ticket node inspector. It sizes to its container: one column, two
from 36rem, three from 56rem; the summary spans the row and the criteria span
two columns. The ticket view reads the same entries (`ticketSectionEntries`)
as one column. Criteria show a status icon, evidence and a tally. The Ticket
node inspector takes the ticks from the newest verify session that is not
superseded and says which round they came from; the node face shows
`n/m criteria`. Board cards show the first prose section and, once Verify has
run, a criteria tally. The verdict in a Verify transcript lists each
criterion's result under the rationale.

## Sync across machines

A project's board is shared by every machine in a fleet that has a copy of
the same repository (matched by repository identity, as everything else
across nodes is). Code: `@orkestrator/protocol/ticket-sync` (wire shapes,
limits, messages), `apps/backend/src/core/storage-kanban-sync.ts` (the rules),
`KanbanSyncRepository` (`storage-kanban-sync-repository.ts`, reached as
`storage.ticketSync`: the sync methods, under the Kanban lease it shares with
`KanbanRepository` through `KanbanBoardStore`),
`nodes/node-ticket-sync.ts` (the command node's runs),
`commands-registry-ticket-sync.ts` (the leaf commands) and
`coordinator-node-tickets.ts` (coordinator tools with a `nodeId`). It is
qualified over two live `dev:test` profiles by `fleet-ticket-sync-live.spec.ts`
([agent-testing.md](../development/agent-testing.md#live-fleet-ticket-sync-two-profiles)).

**One board, one id.** The command node's board is authoritative. A leaf
holds a copy (a *replica*) of each of its tickets under the same id, so a
ticket is recognisable on every machine and a coordinator never needs a
leaf-local id. A replica row carries `sync.replica` (the command node, its
project, and the revisions it last saw). Each command node project pairs with
the first leaf project of the same repository; a second copy on the same leaf
is left alone (one ticket id is one row on a machine), and both boards say so:
the command node's sync line names the leaf copy that syncs and counts the
others, and the other copy's sync line names the copy that syncs.

**Down.** Every synced change to a ticket on any machine is stamped with that
machine's next change sequence (`sync.seq`) and the revision of each field
that changed (`sync.revs`: `title`, `content`, `status`). A deleted ticket
leaves a tombstone with its own sequence. The command node sends a leaf every
snapshot and tombstone after the leaf's cursor, in sequence order, 100 at a
time (`apply_ticket_sync`); the leaf answers with its new cursor
(`get_ticket_sync_cursor` reads it). A leaf that reconnects after any gap
catches up from its cursor. A cursor from another store (`epoch`), or older
than a pruned tombstone (5,000 are kept), gets a full resync that also
removes copies the board no longer has. A field with a leaf change still
queued keeps the leaf's value until the command node has decided it.

**Up.** A change made on a leaf to a replica (edit, status, comment, criteria
results, the build or environment linked to it, deletion) is queued in that
leaf's ticket outbox for that command node in the same commit as the change.
Every queued operation remains immutable until acknowledged: later edits and
deletions receive new sequences, even for newly created tickets or comments.
This preserves changes made while an earlier operation is in transit. The leaf announces queued changes (`ticket-sync-outbox-ready`
on its event stream, which the command node subscribes to by name in
`NODE_SUMMARY_EVENT_PREFIXES`; a leaf's gateway sends nothing outside that
list); the command node collects them (`collect_ticket_sync_outbox`) on that
event, on every connect and stream resync, when it reads a change in the
leaf's project list (its first read after attaching included), and every
60 s, applies them in order,
then acknowledges (`ack_ticket_sync_outbox`). Each outbox has an epoch and a
sequence, and the command node records the last one it applied, so a lost
acknowledgement or a retry never applies a change twice. Over 10,000 queued
changes or 32 MiB the leaf refuses the edit with a message, rather than drop
anything.

**New tickets on a leaf.** A ticket created on a leaf after the command node
first synced that project goes up under its own id and becomes the board's.
Tickets that existed on the leaf before sync began stay on the leaf until the
user shares them: the leaf board's sync line offers "Share N older tickets
with <command node>", and each such card's menu "Share with <command node>"
(`share_tickets_with_command_node`, `KanbanSyncRepository.shareTicketsWithCommandNode`).
Sharing queues the same creation a new leaf ticket does. Nothing is adopted
on first sync: that could copy tickets a user had already duplicated by hand,
and could not be undone.

**Conflicts.** A leaf change to `title`, `content` or `status` made against
the revision the board still has is applied. Against an older one (the field
changed on the command node meanwhile) the board's value is kept, and the
conflict is recorded: in the board's conflict list (the last 200, each with an
id; `get_ticket_sync_status` returns the latest 20 and the total) and as a
comment on the ticket naming the machine and quoting its value, which every
machine then sees. The sync line's conflict count opens the list, where each
conflict opens its ticket or is dismissed, or all are
(`dismiss_ticket_sync_conflicts`); dismissing keeps the ticket's comment. A change that follows the same
leaf's own earlier change is not a conflict. Comments merge by id; criteria
results merge as Verify's do (by id and text), so they never conflict with a
text edit. A change to a ticket deleted on the command node is recorded as a
conflict and not applied; the deletion wins.

**Deletes.** A deletion on either side removes the ticket everywhere. The
tombstone stops a reconnecting leaf from bringing it back, and a leaf keeps
its own so that a snapshot sent before its deletion was collected does not
revive it.

**Images.** Images sync as references (`id`, `filename`, `createdAt` and the
machine holding the bytes, `nodeId`); each machine keeps the bytes of images
attached on it. A command node's snapshots list a ticket's images; a leaf
sends `add-image` and `delete-image` (and its images on a creation) only to a
command node that declared the `images` feature when it collected
(`collect_ticket_sync_outbox` `features`), so an older command node never
receives a change it cannot read, and a snapshot without `images` (an older
command node) leaves a leaf's list alone. Reading an image whose bytes are
elsewhere (`ticket-sync-images.ts`): a command node reads it from the leaf
that holds it (`read_ticket_image`); a leaf, which never reaches its command
node, records a want, announces it like queued changes, and the command node
delivers it on that collection (`wantedImages`, `put_ticket_image`), reading
it from another leaf first when needed. Both keep the copy, so an image
crosses a link once. A machine that is not connected cannot serve its images;
the board says so. Images are bounded per ticket (200 references) and per read
(16 MiB of base64). A leaf's own image the board never listed (attached before
image sync) stays on the leaf; one the board listed and then dropped is
removed there too. A build's ticket snapshot still carries the images the
coordinator or the launcher send with it.

**Order within a column is per machine.** Status syncs, but the order of
tickets within a column does not: `order` changes on every drag and status
move, so syncing it would make most drags conflict. Each machine keeps its
own order; a moved ticket goes to the end of its new column there.

**Where the work runs.** A ticket whose build pipeline or environment runs on
another machine carries `sync.work` (machine, pipeline, environment, pull
request). `start_build_pipeline` with a `nodeId` records it at once; the
leaf's own reports keep it current. The board's cards name that machine.

**The board's sync line.** Above the columns the board names each machine
that shares it, with its state: in sync, syncing, behind, offline (changes
wait here), update needed (an older machine) or failed (retried), and how
many leaf changes lost a conflict. On a leaf it names the command node its
copies come from (`get_ticket_sync_leaf_status`), with the changes waiting for
it and Share for older tickets, and each copy's card carries a small mark with
the command node's name. Nothing shows on a board no other machine shares.

**Older leaves.** A leaf that does not advertise `ticket-sync` is never sent
tickets; the board says to update it. Coordinator tools with its `nodeId`
work on its own board as before (see
[coordinator.md](coordinator.md#tickets-on-other-machines)).

**Detaching.** When a command node detaches, the leaf's copies of its tickets
become the leaf's own, keeping what they say, and nothing more is queued for
it.
