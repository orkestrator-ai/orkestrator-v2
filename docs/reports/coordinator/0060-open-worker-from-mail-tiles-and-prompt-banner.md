# Open the worker from mail tiles and the prompt banner

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Add Open to notice tiles**: a mail tile whose notice names a worker gets an Open action. Status: open.
2. **Add Open to the prompt banner**: a worker's waiting prompt links to its tab. Status: open.

### 1. Add Open to notice tiles

**Problem.** A tile saying a worker finished, failed or needs the user offers only the mail thread. The user has to find the worker elsewhere.

**Context.** The other half of this finding is done: the Work panel replaced the chip and every row has an Open button (see [Current state](#current-state)).

**Investigation.** `MailTile.tsx:275-285` renders only "Open conversation". The delegation wake already carries `notice.resource` with `environmentId` and `tabId` (`coordinator-service.ts:1319-1326`), as does the human-prompt notice (`:1430-1436`). `openCoordinatorWorkTarget` (`apps/web/src/lib/coordinator-work-navigation.ts`) handles a `worker-tab` target. `MailTile` also renders outside coordinator chats.

**Decisions.**

- **Which navigation does the tile use?**
  - **`openCoordinatorWorkTarget` with a `worker-tab` target, only when the notice has an `agent-tab` resource (recommended).**
    - Pros: one navigation path with the Work panel; the tile says nothing it cannot act on.
    - Cons: a notice from another node names a local-looking id; `notice.resource` has no `nodeId`, so a remote worker needs that added or no button.
  - **Only link the name inside the sender text.**
    - Pros: no new control.
    - Cons: the tile's header is already a button, and nesting a link in it is invalid.

### 2. Add Open to the prompt banner

**Problem.** The banner tells the user to answer "in the worker's tab" and gives no way to get there.

**Context.** The banner is shared with ordinary tabs, where the prompt is already in front of the user.

**Investigation.** `HumanPromptBanner.tsx:53` has the text. `CoordinatorPanel.tsx:1043-1049` passes it `workerPrompts` with a `label` prop, and each entry has `environmentId` and `tabId`.

**Decisions.** None: add an optional `onOpen(entry)` prop that the coordinator panel supplies, leaving other callers unchanged.

## Current state

- `eb6bf887a` (#1698) replaced the "Waiting on N workers" chip with the Work panel (`CoordinatorWorkPanel.tsx`), with sections for needs-you, running and finished, and an Open button per row. Open on a row with a question goes to that tab; there is no separate Answer button.

## Related

- [Coordinator report, 4.4 (U1)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [0260-work-panel-row-detail-and-actions.md](0260-work-panel-row-detail-and-actions.md)
