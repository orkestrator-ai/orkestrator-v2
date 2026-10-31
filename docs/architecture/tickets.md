# Tickets: kinds, sections and checkable acceptance criteria

A Kanban ticket has a **kind**, **typed optional sections** stored as JSON, and
two plain-text **mirrors** that every older reader keeps using. Acceptance
criteria are items that a Build pipeline's Verify step marks passed, failed or
not checked, with evidence. The design record (options, pros and cons) is
[0742-structured-tickets.md](../todo/coordinator-and-multi-review/0742-structured-tickets.md).

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
| `delivery` | Delivery | `{ policy?, note? }` | `policy`: `commit-only`, `push-no-pr`, `open-pr`. |
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

## Tools

`create_ticket` and `update_ticket` (worker agent tools and the coordinator's
Control MCP), the public `ticket.create`/`ticket.update` actions, the CLI
(`--kind`, `--sections-file`) and the `add_kanban_task`/`update_kanban_task`
commands accept `kind` and `sections`. A `sections` update replaces only the
sections it names; an empty value clears one. `description` and
`acceptanceCriteria` are still accepted. Reads return `kind`, the text
mirrors, `criteria` (id, text start, status, evidence; bounded) and
`deliveryPolicy`.

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

The backend stores the results on the verify session
(`acceptanceCriteriaResults`, one per snapshot criterion; a skipped criterion is
`not-checked`, an unknown id is dropped), appends the failed criteria to the
feedback the Fix step reads, and writes the results to the Kanban ticket
(`record_kanban_criteria_checks`, best effort, only for criteria whose id and
text still match).

## Views

`TicketSectionsGrid` renders the sections as tiles in render order. It sizes to
its container: one column, two from 36rem, three from 56rem; the summary spans
the row and the criteria span two columns. It is used by the ticket dialog and
the pipeline Ticket node inspector. Criteria show a status icon, evidence and a
tally. The Ticket node inspector takes the ticks from the newest verify session
that is not superseded and says which round they came from; the node face shows
`n/m criteria`. Board cards show the first prose section and, once Verify has
run, a criteria tally. The verdict in a Verify transcript lists each criterion's
result under the rationale.
