# Add a visible Change agent action and mark the main tab

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Add Change agent**: an action on the main tab that closes the conversation and starts the next main on a chosen platform. Status: open.
2. **Mark the main tab**: a visible marker separating it from side agents. Status: open.

### 1. Add Change agent

**Problem.** Closing the main tab is the only way to change provider, and that is explained only in the close button's accessible name.

**Context.** The confirmation half is done (see [Current state](#current-state)). The binding is one-way once a provider session exists (`coordinator-service.ts:665-680`), so "change" means a new conversation.

**Investigation.** The explanation is `closeLabel` at `CoordinatorPanel.tsx:1078-1082`, which `TabShell` sets as `aria-label` with no `title` (`TabShell.tsx:62-66`), and the button hides until hover on fine pointers. The dialog at `:1196-1223` says a new main starts "with the default agent", and gives no choice and no mention that open delegations move. `ensureMainConversation` moves live work to the new main (`coordinator-service.ts:315`). `createConversation` creates an unassigned main when none is open (`:621-623`), and the composer then offers every qualified platform. So the choice already exists if the user is taken to a fresh main rather than left waiting for mail.

**Decisions.**

- **What does the action do?**
  - **Close, then create an unassigned main and focus its composer (recommended).**
    - Pros: reuses the picker and both backend paths; no new command; the user chooses before anything starts.
    - Cons: if mail arrives first, `ensureMainConversation` assigns the default agent before the user picks.
  - **A dialog that picks the platform, then assigns it as part of the close.**
    - Pros: closes the race with mail.
    - Cons: a new atomic backend command, and a second picker to keep in step with the composer's.

### 2. Mark the main tab

**Problem.** Nothing but the title "Coordinator" (`coordinator-service.ts:115`) and tab order shows which conversation is the main.

**Context.** The report suggests a crown or a "Main" pill.

**Investigation.** The tab's contents are at `CoordinatorPanel.tsx:1091-1121`, where the brand mark and any "Choose agent" hint already sit. Its accessible name is set explicitly at `:1096-1100` and would need the same word.

**Decisions.** None: add a small "Main" label only when side agents are open, and include it in the accessible name.

## Current state

- Closing the main always asks first (`CoordinatorPanel.tsx:1083-1087`, dialog `:1196-1223`; `e5245dfd6`, #1644), which is broader than the report's "while a turn is running or delegations are open".

## Related

- [Coordinator report, 4.4 (U2)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [Architecture: One main coordinator](../../architecture/coordinator.md#one-main-coordinator-and-side-agents)
