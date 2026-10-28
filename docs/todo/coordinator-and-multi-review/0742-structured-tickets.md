# Structured tickets: kinds, tiled sections and checkable acceptance criteria

Built 2026-10-28 on `ticket-types-tiled-view-checkable-acs`. The reference is
[tickets.md](../../architecture/tickets.md). This file records the design
decisions and what still needs live evidence.

## Background

The ticket-schema analysis (branches `ticket-schema-analysis-arktech-mini` and
`ticket-schema-analysis-mbp3`, `docs/research/ticket-schema/`) found:

- Coordinator prompts say *how* to work (constraints 92%, reporting 88%, git
  workflow 81%) and none had acceptance criteria. Kanban tickets say *what* to
  build, and 60% have acceptance criteria.
- 71% of criteria are observable behaviour, 28% name a command or test, 1% are
  vague. 22% are the same lint/typecheck/test checklist.
- Delivery policy conflicts between prompts ("commit, don't push", "push, no
  PR, then Multi Review", "open a PR, don't merge"), so it has to be a field.
- Kanban descriptions are 116–409 characters; pipeline snapshots for the same
  work are 2.5–8.7k.

The user decided: two main kinds (work brief and feature ticket); project-wide
rules go in `AGENTS.md`, not tickets; defined optional subsections stored as
JSON and shown as tiles; editing stays text; criteria are checkable by Verify.

## Tasks

1. **Schema, storage and tools**: kind, typed sections, JSON storage with
   migration, markdown round trip, tools accept sections. Status: done.
2. **Tiled view**: ticket dialog and pipeline Ticket node inspector; editing
   opens a text editor. Status: done.
3. **Checkable criteria in Verify**: Verify receives the criteria, records a
   status and evidence for each, the views show the ticks. Status: done.
4. **Live evidence**: a real Build pipeline whose Verify judges criteria on
   each provider, and a real ticket round trip in the app. Status: open.

## Decisions

### 1. Follow-up and steer messages: a ticket kind, or messages?

- **Stay messages; no `follow-up` kind (chosen).**
  - Pros: a steer is a delta to work that is already running, delivered once to
    one tab. Agent mail already gives it durability, delivery state and a
    reply path. A ticket for each steer would fill the board with items that
    have no lifecycle of their own (8 of 26 coordinator items on mbp3; 20
    identical "base on latest main" broadcasts on arktech-mini).
  - Cons: what a steer changed is not on the ticket unless someone records it.
    Mitigation: a steer that changes scope should be followed by an
    `update_ticket` (or a comment), and rules that keep arriving as steers
    belong in `AGENTS.md`.
- **A `follow-up` kind linked to its parent ticket.**
  - Pros: the delta is structured and on the board.
  - Cons: needs parent links, a different lifecycle and delivery into a running
    session that mail already does; doubles the write for every steer.
- Cost of switching later: low. `TICKET_KINDS` is a list, and a new kind with
  a parent id can be added without migrating existing tickets.

### 2. Where the structure lives

- **Sections as JSON on the ticket row, plus two text mirrors (chosen).**
  - Pros: every existing reader (pipeline prompts, Linear and GitHub sync, the
    CLI, older backends on the same data directory) keeps working unchanged.
  - Cons: the text is stored twice; the mirrors have to be kept in step
    (`sectionsBasis` detects a writer that did not).
- **Sections only, with `description` computed on read.**
  - Pros: one copy.
  - Cons: an older backend sharing the data directory would read an empty
    description and could overwrite the sections with a text-only edit.
- **A separate ticket-content store.**
  - Pros: smaller Kanban rows.
  - Cons: two transactions per edit and a second resource-change channel.

### 3. Migration of existing tickets

- **Derive on read, never rewrite (chosen).** Legacy text stays byte for byte;
  sections are derived each read and persisted on the next edit.
  - Pros: nothing is lost or reformatted; no startup migration pass; mixed
    backend versions keep working.
  - Cons: legacy rows are parsed on every read (cheap: a linear pass).
- **One-time migration that renders canonical mirrors.**
  - Cons: reformats every ticket (alias headings renamed, paragraph criteria
    turned into bullets) and cannot be undone by an older backend.

### 4. Markdown section boundaries

- **`##` headings outside code fences; unknown headings become custom sections
  (chosen).**
  - Pros: predictable; `###` stays usable inside a section; nothing is ever
    dropped.
  - Cons: bold lead-ins (`**Problem:**`) and `Label:` lines, common in legacy
    prompts, are not recognised as sections. They stay in the summary, intact.
- **Also recognise bold lead-ins and `Label:` lines.**
  - Cons: false positives in ordinary prose ("Note: …") would split text, and
    the round trip would rewrite the user's formatting.

### 5. Criteria identity and results

- **Ids kept by exact text match; results stored on the item, never in the
  markdown (chosen).** Editing a criterion's text gives it a new id and no
  result.
  - Pros: an edit cannot forge a pass; a changed criterion is never reported
    as passed for the old text; the markdown stays clean to edit.
  - Cons: fixing a typo in a criterion resets its result.
- **Hidden ids in the markdown (`<!-- ac-1 -->`).**
  - Pros: typo fixes keep the result.
  - Cons: noise in every edit, and a pasted id would carry a result to new text.
- **Status markers in the markdown (`[x]`, `[!]`, `[?]`).**
  - Cons: anyone editing could mark a criterion passed. Only a hand-ticked
    `[x]` on an item without a result is honoured, recorded as `manual`.

### 6. Standard checks

- **A separate `checks` list, not criteria (chosen).** The tool descriptions
  steer generic lint/typecheck/test commands there.
  - Cons: legacy tickets keep their checklist criteria; they are not moved
    automatically, because moving them would change what Verify judges.

### 7. Delivery policy values

- **`commit-only`, `push-no-pr`, `open-pr` (chosen).** No `merge`: agents never
  merge into `main` (`AGENTS.md`). A note carries anything else (who runs Multi
  Review, whether to wait for CI).

### 8. Verify contract

- **One verdict with `complete`, `rationale` and `acceptanceCriteria` (chosen);
  the old two-field verdict is still accepted.**
  - Pros: one turn, one schema; old in-flight verify turns still finish.
  - Cons: a model that omits the field in tool mode is accepted with no
    criteria recorded rather than corrected.
- The backend does not override `complete` when a criterion failed. The prompt
  says a failed criterion means `complete: false`; Verify's overall judgement
  stays authoritative, and the failed criteria are added to the Fix feedback.
- A criterion Verify did not report is recorded `not-checked` with that reason,
  never `passed`.
- Results are written to the Kanban ticket best effort: the pipeline record is
  authoritative, and a ticket edited since keeps its own criteria.

### 9. Snapshot criteria ids

- **Store the ticket's criteria (id and text) in the snapshot at start, when
  the ticket's criteria text matches the snapshot (chosen).** Otherwise derive
  ids from the snapshot text deterministically.
  - Pros: results land on the right ticket criteria even after reordering;
    snapshots from coordinators and older clients still work.
  - Cons: a ticket edited between the client's snapshot and the start falls
    back to derived ids, so its results are not written back.

### 10. Tiled layout

- **Container queries (one, two, three columns at 0, 36rem and 56rem) (chosen).**
  - Pros: the same component works in the wide dialog, the narrow inspector
    and on a phone.
- The ticket dialog for an existing ticket widens to `max-w-3xl` so tiles can
  sit side by side; create mode stays narrow and keeps its description and
  criteria fields (they take markdown with `##` sections).

## 4. Live evidence

**Problem.** Every part has unit, service and browser-fixture evidence only.

**Left:**

- Run a real Build pipeline from a structured ticket on Claude and Codex (then
  the other providers) and check that Verify returns one entry per criterion,
  marks unverifiable criteria `not-checked`, and that the ticks reach the board.
- Check that provider-enforced structured output accepts the new verdict schema
  on every provider (arrays of objects with an `enum`).
- Edit a legacy ticket in the app: the text opens unchanged, a title-only save
  leaves the text alone, and a section edit keeps unchanged criteria's ticks.
- A coordinator creating a work brief with `sections` through Control MCP on a
  real stack.
