# 07 — History and document lifecycle

Status: Implemented (2026-09-24) — see the [implementation record](00-index.md#implementation-record).  
Dependencies: [02](02-operation-contracts-and-durability.md),
[04](04-renderer-scheduling-and-recovery.md),
[06](06-validation-deletion-and-recovery.md).  
Findings: U1.

## Outcome

Users can name, duplicate, delete, restore, and recover designs and frames
without maintenance prompts. Undo preserves concurrent work and every restore
creates a new revision. History is bounded and survives application restart.

## Ownership

Extend the private record and service, expose validated UI/MCP actions in
`design-tools.ts` and `commands-registry-design.ts`, and add proposed
`DesignHistoryPanel.tsx`/`DesignLibrary` lifecycle controls. Use a separate
proposed `design-history.ts` for retention and checkpoint files. Reuse dialog,
menu, and confirmation components already in `apps/web/src/components/ui`.

## Lifecycle actions

| Action | Required precondition and result |
| --- | --- |
| Rename canvas | Canvas revision; new revision and updated summary |
| Rename/move/resize frame | Frame revision; changed frame and canvas revisions |
| Duplicate frame | Source frame revision plus destination canvas revision; new frame ID |
| Delete frame | Current frame and canvas structure preconditions; recoverable history entry |
| Duplicate canvas | Explicit source revision; new canvas/frame identities and no copied session/export association |
| Delete canvas | Current canvas revision; step-06 tombstone/recycle-bin entry |
| Restore deleted canvas | Matching tombstone identity/version; new live revision or a clearly labeled copy if identity cannot be retained |
| Restore checkpoint | Current target revision plus checkpoint ID; new revision, never decrement counters |
| Transfer/copy to another environment | Both environments authorized; prefer copy-then-verified-retire over a multi-file move |

All actions use operation admission/receipts. Reserve quotas before duplication
or restoration and validate ownership at execution, not only when opening a menu.

## History representation and atomicity

- [ ] Start with bounded immutable snapshots/checkpoints and a compact history
  manifest inside the private current record. Avoid a general event-sourcing
  or CRDT framework for the first iteration.
- [ ] Each entry records ID, affected frames, before/after revision metadata,
  operation kind, gesture/group ID, bounded actor classification, and timestamp.
  Backend-verified session/client identity determines attribution; arbitrary
  MCP input cannot claim to be another user or agent.
- [ ] Save checkpoint data to a unique owned file, sync it, then atomically
  reference it from the new current record alongside the document/receipt.
  A crash can leave an unreferenced file but must never leave a committed
  history reference pointing to an unwritten checkpoint.
- [ ] Garbage-collect orphaned files only after checking all live manifests and
  in-progress reservations, with bounded scans and age thresholds. Do not race
  a writer that has not yet published its reference.
- [ ] Capture recovery state before whole-frame HTML replacement and deletion.
  A gesture has one meaningful user history boundary, not one per pointermove.
- [ ] Use the index's entry/byte/global limits. Count compressed and decoded
  data separately if compression is introduced; prevent decompression expansion
  beyond document bounds.
- [ ] Preserve protected recovery checkpoints according to a documented policy.
  If limits cannot be met without losing required recovery state, return an
  actionable capacity result before the destructive edit. Never silently claim
  an edit is undoable after dropping its checkpoint.

## Undo/redo semantics

The first release should be conservative and understandable:

1. An ordinary undo references a known committed history entry, its author,
   affected targets, and the result versions produced by that entry.
2. If those targets still have exactly those versions, apply the inverse as
   a new operation. Unrelated frame changes may remain if the inverse is
   explicitly scoped to the affected frame and canvas structure is compatible.
3. Structural/canvas-wide undo requires the exact current canvas precondition;
   do not restore an old complete snapshot over unrelated newer work.
4. If a precondition changed, show what changed and offer a checkpoint preview
   or duplicate-as-new. Do not guess how to merge the inverse.
5. Redo is a new operation against the undo result. Any incompatible subsequent
   edit invalidates that redo branch; history remains viewable.

- [ ] Add server-side undo eligibility, not only a client-maintained stack.
- [ ] Identify own user edits versus agent edits clearly in the timeline.
- [ ] Offer explicit checkpoint restore for an agent replacement even when it
  is not eligible for one-click undo; show affected scope before applying.
- [ ] Keep selection and session links out of portable snapshots. Restoring
  visual content does not rewind or delete an agent conversation.
- [ ] Increment content/structure identities appropriately after restore so old
  selectors and cached captures cannot silently apply.

## UI and storage management

- [ ] Add canvas/frame context menus and inline rename with input validation.
- [ ] Duplicate creates a nearby frame or a distinct canvas and focuses it.
  Delete is recoverable, with Undo where eligible and a visible trash entry.
- [ ] Add a history panel with bounded pagination, checkpoint preview, actor,
  time, and operation summary. Content previews are explicit reads, not payloads
  included in every timeline row.
- [ ] Show active/recycle-bin quota usage and a deliberate purge control.
- [ ] For environment removal, explain whether designs are only workspace-held
  or have exports; support an explicit export/copy workflow without making a
  hidden background agent session responsible for preserving them.
- [ ] Cancellation or failure during cross-environment copy leaves the source
  untouched. Retire it only after destination success is verified and requested.

## Required tests and completion

- [ ] Rename/duplicate/delete/restore each obey CAS and environment ownership.
- [ ] Repeated duplicate token creates exactly one new identity.
- [ ] Undo a style edit after an unrelated frame changes; preserve that frame.
- [ ] Undo after an agent changed the same target; conflict rather than clobber.
- [ ] Undo/redo across reload with retained history; counters never decrease.
- [ ] Crash before checkpoint publication and after current-record replacement;
  current state and history references remain coherent.
- [ ] Fill entry/byte/global history budgets, pin protected checkpoints, and
  verify pruning or explicit refusal before mutation.
- [ ] Delete and restore while another client is inactive; its next snapshot
  correctly replaces tombstone/live state.
- [ ] Import/export does not leak history, actor identifiers, or session links.

Review slices: lifecycle actions; checkpoint persistence/retention; conservative
undo/redo; management/history UI; cross-environment copy and removal messaging.
Do not make the optional transfer UI a prerequisite for shipping safe undo.

## Implementation notes (2026-09-24)

- Persistent bounded history (`design-history.ts`): immutable checkpoint files written before the record references them, 50 entries / 64 MiB per canvas, 512 MiB globally, 3 protected entries, gesture grouping, orphan collection.
- Per-actor undo/redo, eligible only while affected targets keep the entry's result versions (chained undo/redo recognised); restore checkpoint creates a new revision.
- Lifecycle actions through operations: rename/duplicate/delete/restore canvas, duplicate/delete frame. UI: `DesignHistoryPanel.tsx`, `DesignCheckpointPreview.tsx`, library lifecycle actions, and an environment-deletion notice (`DesignEnvironmentDeletionNotice.tsx`).
- Deferred: cross-environment transfer UI (optional); copies are possible via recovery copy, download and import.
