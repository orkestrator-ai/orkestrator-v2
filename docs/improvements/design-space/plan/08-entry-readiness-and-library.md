# 08 — Entry, readiness, and design library

Status: Planned.  
Dependencies: [03](03-client-controller-and-reconciliation.md),
[05](05-safe-saving-and-export.md),
[06](06-validation-deletion-and-recovery.md),
[07](07-history-and-document-lifecycle.md).  
Findings: U1, U2.

## Outcome

The design entry point remains useful when headless Chromium is unavailable.
Users can distinguish Create, Open, and Import, locate saved work, recover a
prerequisite failure, and reopen an existing canvas without consuming another
split/tab unnecessarily.

## Owners

Refactor `DesignLaunchButton.tsx` into a small toolbar entry plus proposed
`DesignWorkspaceDialog.tsx`, `DesignLibrary.tsx`, and `DesignReadinessPanel.tsx`
only where it improves ownership. Extend `design-launch.ts`,
`TerminalContainer.view.tsx`, pane layout actions, renderer health, and the
service's metadata summary projection.

## Capability and readiness model

- [ ] Report backend connection, document storage, browser executable discovery,
  actual browser launch health, render queue health, and selected-agent
  availability as separate facts.
- [ ] Cache successful on-demand render health for a short bounded lifetime
  (initial proposal: 60 seconds); deduplicate concurrent probes. Invalidate on
  path/config changes, generation death, and explicit Retry.
- [ ] A probe uses the scheduler and its deadlines. It does not run on every
  toolbar mount or hold a document write lock.
- [ ] Distinguish “install Chromium on this backend” from “browser failed to
  launch,” “render service recovering,” and “queue temporarily full.” Render
  backend identity in UI without disclosing secrets or local paths unnecessarily.
- [ ] Keep the entry button focusable. Open a readiness panel instead of hiding
  all functionality behind a disabled button/title tooltip.

| Capability state | Available user actions |
| --- | --- |
| Backend/storage available, renderer unavailable | List, reopen, client preview where valid, rename, export, import as unvalidated |
| Renderer healthy, selected agent unavailable | Manual canvas work, use another available supported agent, setup guidance |
| Backend disconnected | Browse labeled cached projection; retain drafts; reconnect before committing |
| Document deleted/invalid | Recovery actions from steps 06/07, not normal editing |

Do not guess provider availability from a hard-coded frontend list beyond the
currently supported Claude/Codex design launch. Read the existing discovery
and authentication projections; toolchain setup belongs to existing workflows.

## Create/Open/Import experience

- [ ] Present three clear modes with appropriate headings and primary actions.
  Preserve a draft brief if the user switches modes or a launch fails.
- [ ] New design offers name, supported agent, brief examples, and initial frame
  preset. Explain static HTML/CSS, embedded resources, and blocked authored JS.
- [ ] Allow a manual blank canvas without launching an agent. Reserve a
  conversation only if the user chooses that path.
- [ ] Validate blank/whitespace names, name length, tab capacity, split depth,
  and environment state before creating durable resources.
- [ ] Model launch stages explicitly: create document, allocate layout, bind
  conversation, submit initial prompt. Do not dispatch an initial agent prompt
  until the required canvas/layout association is established.
- [ ] If layout allocation fails before dispatch, roll back only resources
  created by that attempt. After agent dispatch, offer recover/open controls;
  do not delete an active canvas out from under a running agent.
- [ ] Import validates file type/bytes/version, reports unsupported content,
  assigns fresh identities, and does not copy foreign session/export links.

## Library and reopening

- [ ] Add name search, modified-time sorting, environment scope, live/deleted
  filter, frame count, and workspace/export state. Cap and paginate summaries;
  do not fetch every document to draw the list.
- [ ] Populate the initial summary projection from step-02 private metadata and
  durable commits. Step 14 optimizes persistence/rebuild and proves listing cost;
  the library does not depend on that later optimization to return correct
  names, times, frame counts, and status today.
- [ ] Add thumbnails opportunistically as low-priority bounded jobs. A missing
  renderer/cache produces a placeholder rather than blocking the library.
- [ ] Clear/reset the list on backend/environment changes and reject late list
  responses for an old key. Show loading, empty, error, and quota states.
- [ ] Search existing tabs by canvas identity before checking capacity. Focus
  the existing tab even at MAX_TABS or maximum split depth.
- [ ] For unopened canvases, offer current-pane tab or adjacent split; fall
  back to current-pane when split depth prevents the preferred layout.
- [ ] Treat actual tab capacity separately: opening in the current pane cannot
  bypass MAX_TABS. Explain how to close/reuse a tab without losing the canvas.
- [ ] Expose rename/duplicate/trash/restore using step-07 actions. A failed action
  keeps selection and reports the relevant error without clearing the list.

## UX acceptance tasks

1. With missing Chromium, open the design library, inspect an existing design,
   export it, and understand why backend capture is unavailable.
2. Install/fix Chromium externally, press Retry, and become ready without
   changing environments or restarting the whole app.
3. At maximum split depth, reopen a closed canvas in the current pane; at the
   tab limit, focus a canvas that is already open.
4. Find a design among at least fifty entries, rename it, duplicate it, trash
   the duplicate, and restore it without an agent prompt.
5. Start creation, force layout failure before dispatch, and verify no orphan
   canvas or running agent. Force failure after dispatch and recover existing work.
6. Change environments while a library request is delayed; no wrong-environment
   entries or launch callbacks appear.

## Verification / review slices

- [ ] Backend capability/summary contracts with no-renderer tests.
- [ ] Entry/readiness panel with keyboard and screen-reader state announcements.
- [ ] Open/focus/layout logic with tab/split boundary tests.
- [ ] Create transaction and manual canvas path with failure-stage tests.
- [ ] Library/import/lifecycle browser coverage at desktop and narrow widths.

Use the isolated application profile for final UI qualification. Thumbnail
polish may follow the library's functional release; it must not gate reopening.
