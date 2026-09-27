# 06 — Validation, deletion, and error recovery

Status: Implemented (2026-09-24) — see the [implementation record](00-index.md#implementation-record).  
Dependencies: [02](02-operation-contracts-and-durability.md),
[03](03-client-controller-and-reconciliation.md),
[04](04-renderer-scheduling-and-recovery.md).  
Findings: R5.

## Outcome

A malformed or unsupported frame has a precise, recoverable state without
breaking healthy frames. A deleted canvas becomes a deleted state on every
client, including one that missed the deletion event. Temporary disconnection
never masquerades as deletion or an empty document.

## Owners and contracts

Extend `design-service.ts`, `design-tools.ts`, `design-runtime.ts`,
`commands-registry-design.ts`, `DesignFrameView.tsx`, and the step-03 controller.
Introduce a proposed bounded `DesignFrameValidation` projection with:

- Frame ID, content identity, runtime validation version, and validation time.
- State: unvalidated, validating, valid, invalid, or renderer unavailable.
- Reason codes and bounded counts for removed scripts, handlers, unsupported
  external references, DOM limit, invalid selector, and runtime timeout.
- A safe user-facing description and supported recovery actions. Diagnostics
  must not include raw markup, resource URLs containing secrets, or attributes.

Add snapshot outcomes for available, deleted, missing, and unavailable. Missing
means no retained record proves identity, while deleted has a retained tombstone.
Both disable editing; unavailable preserves the last known projection as stale.
Authorization failures must not reveal another environment's canvas existence.

## Validation policy

- [ ] Share one sanitizer and DOM limit implementation between backend and
  iframe. Check byte limits before parsing and element/depth budgets after
  sanitization, including nested template content according to explicit rules.
- [ ] Distinguish source validity from supported rendering: removal of scripts
  or remote assets is a supported transformation with warnings, whereas an
  over-limit DOM is a failure. Do not silently broaden resource permissions.
- [ ] For new raw HTML edits with a healthy renderer, validate/render before
  committing and recheck the target revision after validation. Failed changes
  retain the old authoritative frame and the user's rejected draft.
- [ ] For import while Chromium is unavailable, permit a bounded stored document
  marked unvalidated with explicit read/preview/export access. Do not label it
  validated or enable backend selector edits until validation succeeds.
- [ ] Legacy documents begin with unknown validation metadata. Validate lazily
  by content identity; do not spawn Chromium for every document at startup.
- [ ] Validation jobs are backend-owned and low priority relative to submitted
  edits. They cannot update status for a newer frame version using an old result.
- [ ] A raw edit accepted through a compatibility route must also enter this
  policy; bypassing it through legacy MCP must not create an apparently valid
  frame that fails only when displayed.
- [ ] Bound every diagnostic list and count, with a truncation indicator.

## Frame recovery UI

- [ ] Show per-frame loading/invalid/unavailable overlays and keep the rest of
  the canvas usable. Preserve dimensions/name so the user can locate the frame.
- [ ] Offer Retry validation, Edit/replace source through the existing agent
  workflow, and Restore previous version when history is available in step 07.
- [ ] Retain the last successfully rendered view only with a clear “previous
  revision” label; disable element mutation against a failed current version.
- [ ] Add a details panel for unsupported features and bounded diagnostics.
  Explain that data images/fonts and embedded CSS are supported; scripts and
  external requests remain blocked.
- [ ] Retry uses the authoritative current content identity and does not create
  a revision merely for checking validity.
- [ ] Clear a frame error only when that frame/version recovers. Unrelated
  successful synchronization must not hide it.

## Deletion and tombstones

1. Validate ownership and expected canvas revision; acquire the canvas lane.
2. Fence new edits and any in-flight render result for that incarnation.
3. Atomically persist a tombstone plus deletion operation receipt. Publish a
   content-free deletion hint only after the record is durable.
4. `changes`/snapshot reads return the tombstone even if the client missed the
   hint or presents an expired cursor.
5. Reclaim content/history according to step 07's recycle-bin retention. Purging
   a record must not make old execution tokens executable again.

- [ ] Define deletion state independently of an event ring entry. Do not erase
  the sole evidence and rely on a transient event to tell clients what happened.
- [ ] Retained deleted records count against recycle-bin byte/count limits.
  Free active-canvas quota on deletion while preserving bounded recovery data.
- [ ] A purged/unknown canvas returns a typed noneditable outcome; do not leak
  filesystem `ENOENT` details into a generic repeating Refresh message.
- [ ] Environment deletion fences all associated work before removing records.
  Late operation/export cleanup must not resurrect documents or sessions.
- [ ] Display a deleted-state panel with Close and, when allowed, Restore.
  A client-only last-known copy may be offered as Save recovery copy, labeled
  with its known revision and uncertainty; it must create a new identity.

## Verification matrix

| Scenario | Required behavior |
| --- | --- |
| Under-byte-limit HTML with over-limit element count | Explicit rejection/invalid state; healthy frames remain usable |
| Scripts, handlers, remote CSS/font/image references | Blocked as before; useful bounded warning counts |
| Invalid frame followed by valid replacement | Error clears for new content; editing becomes available |
| Validation finishes after a newer edit | Old diagnostic cannot overwrite new validity state |
| Missing Chromium on import | Stored unvalidated state and available read/export actions |
| Delete from another client, drop final hint | Cursor/snapshot reconciliation still shows deleted |
| Backend offline while canvas exists | Stale/offline, not deleted |
| Render completes after canvas/environment deletion | No commit/resurrection |
| Delete receipt lost and backend restarts | Operation lookup and tombstone agree |
| Purged canvas ID reused in an old execute request | Rejected, never recreated |

Review slices: diagnostic contract/shared validation; frame-specific UI;
versioned deletion and fencing; inactive/restart recovery tests. Run actual
Chromium sanitizer cases, not only a DOM emulator, for browser policy claims.

## Implementation notes (2026-09-24)

- Shared sanitizer/DOM budget with a `validate` report (removed scripts/handlers, blocked external references, element count incl. template contents). Raw HTML is validated before commit when the renderer is healthy; otherwise stored `renderer-unavailable`. Legacy frames validate lazily by content identity; stale results never overwrite newer content (`design-validation.ts`).
- Tombstones on deletion, `deleted`/`missing`/`record-problem` snapshot states, environment deletion fencing, recycle bin retention (32 designs, 128 MiB, 7 days), explicit purge.
- UI: per-frame repair overlay, blocked-content notice, deleted/missing/problem panel with Restore and Save recovery copy.
- Tests: `design-lifecycle.test.ts`, `design-sync.test.ts`, `design-runtime.test.ts`.
