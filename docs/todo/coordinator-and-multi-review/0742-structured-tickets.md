# Structured tickets: kinds, tiled sections and checkable acceptance criteria

Built 2026-10-28 on `ticket-types-tiled-view-checkable-acs` (merged as #1388,
`ce117241`). The reference is [tickets.md](../../architecture/tickets.md).
This file records the design decisions and what still needs live evidence.

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`; statuses re-checked
2026-10-30 against `main` at `cd7bbe3e`.

The build items (schema and tools, the tiled view, checkable criteria in
Verify) are done and listed with their evidence. What is left is live
evidence, split here into its four parts. None of tasks 4 to 7 had been run by
2026-10-30: none of the 39 commits since `79f3bc97` touches the ticket schema,
storage or dialog, or records live evidence here. Task 6 is now done (see
below); tasks 4, 5 and 7 need billed provider turns.

### Tasks

1. **Schema, storage and tools**: kind, typed sections, JSON storage with migration on read, markdown round trip, tools accept sections. Status: done.
2. **Tiled view**: ticket dialog and pipeline Ticket node inspector; editing opens a text editor. Status: done.
3. **Checkable criteria in Verify**: Verify receives the criteria, records a status and evidence for each, the views show the ticks. Status: done.
4. **Live Verify on each provider**: a real Build pipeline from a structured ticket whose Verify judges each criterion and whose ticks reach the board. Status: open (needs live providers).
5. **Provider-enforced verdict schema**: each provider's structured output accepts the new verdict schema. Status: open (checked by the runs in 4).
6. **Legacy ticket round trip in the app**: a legacy ticket opens unchanged, a title-only save leaves it alone, a section edit keeps unchanged ticks. Status: done (2026-10-30, hand-made legacy rows; one fix, see below).
7. **Coordinator work brief through Control MCP**: a coordinator creates a work brief with `sections` on a real stack. Status: open (needs a live provider).

### 1. Schema, storage and tools

**Problem.** Tickets had one free-text description and one criteria field.

**Context.** Decisions 2 to 7 below.

**Investigation.** Done in #1388 (`ce117241`). `TICKET_KINDS` is
`["feature", "work-brief"]` (`packages/protocol/src/ticket-sections.ts:28`),
`DELIVERY_POLICIES` is `commit-only`, `push-no-pr`, `open-pr` (`:86`), and
`sectionsBasis` is the mirror fingerprint (`:710`). `create_ticket` and
`update_ticket` accept `sections` (`apps/backend/src/core/control-mcp-tools.ts:1132-1162`,
`:1196`). A legacy row reads with derived sections and is not rewritten
(`apps/backend/src/core/storage-kanban-sections.test.ts:43`).

**Decisions.** None; done.

### 2. Tiled view

**Problem.** A long ticket was one block of text.

**Context.** Decision 10 below.

**Investigation.** Done in #1388. `TicketSectionsGrid` is a container-query
grid, one column, two from `@xl` (36rem), three from `@4xl` (56rem)
(`apps/web/src/components/tickets/TicketSectionsGrid.tsx:202-205`). It is used
by the ticket dialog and by `PipelineTicketView`
(`apps/web/src/components/build-pipeline/PipelineTicketView.tsx:6`). The
dialog for an existing ticket widens to 48rem through
`--modal-max-width` (`apps/web/src/components/kanban/KanbanTaskDialog.tsx:166`,
`:985`), the width of `max-w-3xl`; create mode keeps 560px (`:163-164`,
`:867`).

**Decisions.** None; done.

### 3. Checkable criteria in Verify

**Problem.** Verify returned one pass or fail with no per-criterion result.

**Context.** Decisions 5, 8 and 9 below.

**Investigation.** Done in #1388. The snapshot stores the ticket's criteria
ids at start (`apps/backend/src/core/build-pipeline-service-lifecycle.ts:459-490`),
otherwise derived by `taskSnapshotCriteria`
(`packages/protocol/src/build-pipeline.ts:110`). The verdict schema adds
`acceptanceCriteria` with `status` from `passed`, `failed`, `not-checked`
(`build-pipeline.ts:493-523`); the prompt asks for one entry per id
(`apps/backend/src/core/build-pipeline-prompts.ts:649`, `:665`). An unreported
criterion becomes `not-checked` (`build-pipeline.ts:595`). The old two-field
verdict is still accepted
(`apps/backend/src/core/workflow-result-contracts.ts:630`). Results are stored
on the verify session and written to the ticket best effort
(`apps/backend/src/core/build-pipeline-service-recovery.ts:194-195`, `:436`;
`record_kanban_criteria_checks` in
`apps/backend/src/core/commands-registry-kanban.ts:107`).

**Decisions.** None; done.

### 4. Live Verify on each provider

**Problem.** Every part has unit, service and browser-fixture evidence only.
A Verify step that misreads the criteria would mark tickets wrongly on every
run.

**Context.** No live spec runs a Build pipeline's Verify against criteria
(`e2e/agent-testing/` has no such case). The live provider runs for other
providers are batched in
[0031](../cross-cutting/0031-live-provider-and-platform-qualification.md).

**Investigation.** Nothing has been run live since #1388.

**Decisions.**

- **What ticket and what result count as a pass?**
  - **A feature ticket with three criteria: one a command in the checkout proves, one deliberately false, one that cannot be checked in the checkout (for example a deployed page). Pass when Verify returns exactly one entry per id with `passed`, `failed` and `not-checked` in that order, `complete` is false, the failed criterion appears in the Fix step's feedback, and the board card and Ticket node show the ticks (recommended).**
    - Pros: exercises all three statuses, the Fix feedback and the write-back in one run.
    - Cons: the false criterion makes the pipeline loop into Fix, so the run is longer.
  - **A ticket whose criteria all pass.**
    - Pros: a short run.
    - Cons: never shows `failed` or `not-checked`, which are the parts most likely to be wrong.
- **Which providers, and how?**
  - **Claude and Codex first in a disposable `mise run dev:test` profile, recorded in this file; Cursor, Pi, OpenCode and Grok later with 0031's credential runs (recommended).**
    - Pros: the two main providers are signed in here; no new harness for a check that needs a judgement call on each verdict.
    - Cons: manual evidence; a regression needs another manual run.
  - **A new opt-in live spec.**
    - Pros: repeatable.
    - Cons: a lot of harness for a pipeline run with a Fix loop, before anyone knows it fails.

### 5. Provider-enforced verdict schema

**Problem.** Providers that enforce structured output may reject or strip parts
of the new schema (arrays of objects with an `enum`).

**Context.** The schema has no `maxItems` because several providers reject it
(`packages/protocol/src/build-pipeline.ts:491-492`). It is handed to the
provider through `outputSchema`
(`apps/backend/src/core/http-bridge-prompt-body.ts:33`), which the Claude,
Codex, Cursor, Pi and ACP bridges read.

**Investigation.** Not run. A rejection would show as a failed Verify turn or a
verdict accepted through the legacy two-field path with no criteria.

**Decisions.**

- **How should it be checked?**
  - **As part of the task 4 runs: a pass also needs the verdict to be accepted without the legacy fallback and with no provider schema error in the turn (recommended).**
    - Pros: no extra runs; it tests the schema exactly as Verify sends it.
    - Cons: a provider is covered only when its task 4 run happens.
  - **A separate call per provider with the schema and a trivial prompt.**
    - Pros: quick, and covers every provider at once.
    - Cons: bypasses the bridge and the prompt Verify uses, so it can pass where Verify fails.

### 6. Legacy ticket round trip in the app

**Problem.** Derive-on-read and the mirrors are tested in storage and
components, not in the app with real old tickets.

**Context.** Decisions 2 and 3 below; "Mirrors and migration" in
[tickets.md](../../architecture/tickets.md).

**Investigation.** Run 2026-10-30 with hand-made legacy rows (see
Assumptions and decisions), in two ways.

- *In the app.* A disposable `dev:test` profile (`--fixture
  --no-agent-credentials`), three legacy rows written into the profile's
  Kanban store (bold lead-ins and `Label:` lines with a `- [x]` and a nested
  bullet; `## Background`/`## Done when` aliases with criteria in both fields;
  CRLF line endings), then driven through the ticket dialog with Playwright.
  Opening each ticket and saving the editor untouched left the store
  byte-identical. A title-only save changed only `title`; `description` and
  `acceptanceCriteria` stayed byte-identical and no `sections` were written.
  A section edit (a line added to the summary) kept every criterion's id and
  tick, and a fresh page load showed the same ticks. The profile was stopped
  and reset afterwards.
- *Repeatably.* `apps/backend/src/core/storage-kanban-legacy-round-trip.test.ts`
  runs seven legacy shapes (the three above plus criteria only in the
  description, code fences and `###` subheadings with numbered criteria,
  paragraph criteria, and custom, repeated and delivery headings) through
  `update_kanban_task` with the payloads the dialog sends. A dialog test
  (`tests/unit/components/KanbanTaskDialog.test.tsx`, "a legacy ticket opened
  in the editor and saved untouched sends nothing") covers the client side.

Found and fixed: a section edit kept a legacy hand tick (`- [x]`) as passed but
re-dated it to the save. Reads date it at the ticket's creation
(`normalizeKanbanTask`), but `updateKanbanTask` derived the legacy sections
without that date, so the kept result changed its `checkedAt`. The update now
normalizes the row as a read does first
(`apps/backend/src/core/storage-kanban.ts`, `updateKanbanTask`). Without the
fix six of the new section-edit cases fail.

Seen and left as designed: the editor shows an alias heading under its
canonical name, criteria without their `[x]` (ticks are results, not text) and
paragraph criteria as bullets; saving that text untouched sends nothing, and
any real edit saves the canonical form (decisions 3 and 4 below). The board
card preview shows the summary as plain text, so `**Problem:**` appears with
its asterisks there; the dialog renders it.

**Decisions.**

- **Which tickets?**
  - **A copy of real tickets written before #1388, loaded into a disposable `dev:test` profile (recommended; not taken, see Assumptions and decisions).** Pass when the text opens unchanged, a title-only save leaves `description` and `acceptanceCriteria` byte for byte, and a section edit keeps the ticks of criteria whose text did not change.
    - Pros: real formatting (bold lead-ins, `Label:` lines, `- [x]` items) that hand-made tickets miss.
    - Cons: copies user data into a test profile, which must be reset afterwards.
  - **Hand-made legacy rows.**
    - Pros: no user data involved.
    - Cons: only the shapes the tester thinks of.

### 7. Coordinator work brief through Control MCP

**Problem.** No real coordinator has created a ticket with `sections`.

**Context.** `create_ticket` accepts `sections` or plain text
(`control-mcp-tools.ts:1132`).

**Investigation.** Not run.

**Decisions.**

- **How should it be run?**
  - **One Claude coordinator turn in the same `dev:test` profile as task 6, asked to create a work brief with summary, constraints, criteria and delivery policy; pass when the ticket shows those tiles and its text mirrors match (recommended).**
    - Pros: cheap; shares the profile.
    - Cons: one provider only.
  - **A new scenario in the live coordinator suite.**
    - Pros: repeatable, every platform.
    - Cons: a full suite scenario for one tool call.

## Current state

- Built and merged in #1388; behaviour is in
  [tickets.md](../../architecture/tickets.md).
- Two kinds (feature ticket, work brief); typed optional sections stored as
  JSON with a lossless markdown round trip and two text mirrors; a tiled view
  in the ticket dialog and the pipeline Ticket node; acceptance criteria that
  Verify marks passed, failed or not checked with evidence.
- Evidence for Verify and the coordinator tools is unit, service and
  browser-fixture tests only. The legacy round trip (task 6) was run in the app
  on 2026-10-30 with hand-made rows.

## Outstanding work

### Qualification

Live evidence (tasks 4, 5 and 7):

- Run a real Build pipeline from a structured ticket on Claude and Codex (then
  the other providers) and check that Verify returns one entry per criterion,
  marks unverifiable criteria `not-checked`, and that the ticks reach the board.
- Check that provider-enforced structured output accepts the new verdict schema
  on every provider (arrays of objects with an `enum`).
- A coordinator creating a work brief with `sections` through Control MCP on a
  real stack.

## Constraints and rationale

### Background

The ticket-schema analysis (branches `ticket-schema-analysis-arktech-mini` and
`ticket-schema-analysis-mbp3`, `docs/research/ticket-schema/` on those
branches, not on `main`) found:

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
- The ticket dialog for an existing ticket widens to 48rem (the width of
  `max-w-3xl`, set through `--modal-max-width`) so tiles can sit side by side;
  create mode stays narrow and keeps its description and criteria fields
  (they take markdown with `##` sections).

## Assumptions and decisions

### Task 6: hand-made legacy rows, not a copy of real tickets

The recommended option was a copy of real pre-#1388 tickets. The coordinator
asked for hand-made rows only and for no reading or copying of the user's
data directory, so that was not taken. To make up for the shapes a tester
might miss, the rows cover each legacy form the parser treats differently:
bold lead-ins and `Label:` lines, alias headings, criteria in the description
and in both fields, CRLF, code fences, `###` subheadings, numbered, nested and
paragraph criteria, `[x]`/`[X]`/`[ ]` markers, unknown and repeated headings,
and an unknown delivery policy. A real ticket in a shape outside that list is
still untested.

### Task 6: "opens unchanged" means the stored text and an untouched save

The editor shows the canonical markdown, not the stored text verbatim (an alias
heading is renamed, ticks are not shown, paragraph criteria become bullets).
That is decisions 3 to 5 below. The pass condition taken was: reading and
opening never writes the row; the tiles show all of the text; the editor text
parses back to the same sections; and saving it untouched sends nothing.

### Task 6: fix the re-dated hand tick in storage, not in the protocol helper

`updateKanbanTask` now passes the row through `normalizeKanbanTask` before
`applyTicketContentUpdate`, as `recordKanbanCriteriaChecks` already did. Giving
`applyTicketContentUpdate` the creation date instead would also date a box
ticked *in this edit* at creation, which is wrong. The new test checks both.

### Task 6: in-app run and repeatable test, not a new real-stack spec

The in-app run gives the live evidence once; the backend and dialog tests keep
it from regressing in the default suite. A Playwright spec under
`e2e/agent-testing/` would need a way to seed legacy rows into a running
profile and would only run on demand, for a path the default suite now covers
end to end below the browser.

### Tasks 4, 5 and 7: left open

All three need billed provider turns (a Build pipeline's Verify, and a
coordinator turn), which this worker was told not to make. Their analyses and
recommended options stand unchanged.

## Related

- [tickets.md](../../architecture/tickets.md)
- [0315-build-pipeline-flow-graph.md](0315-build-pipeline-flow-graph.md) (the
  pipeline Ticket node)
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
  (batched provider runs)

## Replaces

Nothing; new design record.
