# 12 — Incremental synchronization

Status: Planned.  
Dependencies: [02](02-operation-contracts-and-durability.md),
[03](03-client-controller-and-reconciliation.md),
[06](06-validation-deletion-and-recovery.md).  
Findings: E1.

## Outcome

Geometry-only edits do not transfer unchanged HTML or reconstruct iframe DOM.
Changed-frame updates form a coherent transition between known canvas revisions.
Any gap, incompatible generation, or expired range repairs through an
authoritative snapshot.

## Owners

Shared contracts in `design-canvas.ts`; change metadata/reads in
`design-service.ts`; gateway commands in `commands-registry-design.ts`; decoding
and capability fallback in `design-client.ts`; installation in the controller;
render invalidation in `DesignFrameView.tsx`/`frame-bridge.ts`.

## Protocol proposal

Keep ordinary live hints content-free. Introduce a versioned sync response with
one of these explicit forms:

| Form | Contents |
| --- | --- |
| Unchanged | generation, confirmed revision, optional separate metadata/status versions |
| Delta | generation, exact base revision, resulting revision, bounded canvas patch, frame additions/patches/removals |
| Reset required | generation/current revision plus reason; client requests a snapshot |
| Snapshot | coherent envelope from step 02 |
| Deleted/missing | explicit noneditable state from step 06 |

Each changed frame includes its resulting full frame revision and separate
content/structure/viewport identities. Geometry patches omit HTML. HTML is
included when its content identity changed, and on new frames. Omitted fields
mean unchanged, not empty/reset. Canvas rename, ordering, validation metadata,
and frame deletion have explicit semantics.

Operation lifecycle/status, validation, and export metadata may change without
a document edit. Use step 02's separate monotonic metadata/status versions;
do not invent document revisions for queue progress or compare them
as though they were the same cursor. The snapshot envelope reports all relevant
versions and each partial response names the axis it updates.

## Backend algorithm

- [ ] Retain bounded content-free change descriptors identifying operation
  scope, changed fields, removed IDs, and revisions. Preserve the existing
  count/byte limits and explicitly reset if the needed range is unavailable.
- [ ] Capture the current immutable record and replay-range metadata at one
  coherent boundary. Build a net transition from the client's base to that
  exact resulting revision; do not read individual frames at unrelated times.
- [ ] Include frames affected anywhere in the retained range. A frame changed
  twice needs only its final state for a net delta, but removals and additions
  must still reconcile identity correctly.
- [ ] If a coherent delta cannot be represented within bounded bytes/counts,
  return reset-required. Initial proposal: at most 256 KiB per delta and at most
  64 changed frame descriptors; a near-limit HTML frame can legitimately force
  a snapshot instead of raising limits.
- [ ] Do not duplicate large HTML into the event ring just to simplify deltas.
  Read content from the captured authoritative record when answering a client.
- [ ] Preserve subscribe-before-read behavior. Connected frames echo client
  cursors where relevant; no cursor jumps over unprocessed replay.
- [ ] A new generation, future cursor, missing revision, unknown change kind,
  purged tombstone, or unsupported response version has an explicit fallback.

## Client installation and mutation acknowledgment

- [ ] Install a delta only when controller generation and applied document
  revision exactly match its base. Validate all patches before applying any.
- [ ] Apply all frame/canvas changes and advance the revision in one store update.
  No consumer observes half the transition labeled with the resulting revision.
- [ ] On mismatch, discard the delta and fetch a snapshot. Do not apply what
  “seems relevant” and then advance the cursor anyway.
- [ ] A mutation acknowledgment can carry the same contiguous patch contract.
  If it skips another writer's revision, settle the operation receipt but wait
  for sync before declaring the entire canvas projection current.
- [ ] Coalesce rapid hints under a bounded refresh cadence with a dirty flag;
  ensure the final change is checked even if every final hint is lost.
- [ ] Deduplicate hint/cursor polling for repeated views through step 03.
  Backoff disconnected reads; immediately reconcile on activation/reconnection.
- [ ] Count received/decoded bytes and response copies during benchmarks, not
  only WebSocket/SSE hint size.

## Render invalidation

- [ ] Replace iframe HTML only on content identity/runtime identity changes.
  A changed frame revision alone is no longer a render dependency.
- [ ] x/y/name changes update outer frame chrome and transforms only.
- [ ] Width/height changes resize the viewport and refresh layout-dependent
  bounds/computed styles without replacing identical HTML.
- [ ] Regenerate hierarchy only on structure identity changes or a documented
  label/attribute change that affects its displayed rows.
- [ ] Track rendered content identity separately from the latest frame revision.
  Selection remains governed by step-09 target validation; skipping an HTML
  render must not accidentally authorize a stale selector edit.
- [ ] Ignore old render/hierarchy acknowledgments after content replacement or
  iframe generation change. Recreated iframes always receive a full current render.

## Verification and targets

- [ ] Move/rename a frame: no unchanged HTML in response and no DOM replacement.
- [ ] Resize: same document nodes, updated viewport/bounds, accurate selection.
- [ ] Style edit: only changed frame content transfers; other iframes retain DOM.
- [ ] Concurrent changes to two frames: one coherent resulting canvas snapshot.
- [ ] Drop/reorder/duplicate hints, lose final hint, expire ring, restart backend,
  or supply future cursor: eventual exact snapshot equality.
- [ ] Delete/create/restore frames across retained range: no ghost/duplicate IDs.
- [ ] Oversized delta returns reset and succeeds via bounded snapshot path.
- [ ] Validation/operation/export metadata changes without document edits are
  still visible and do not corrupt the document cursor.
- [ ] New client against old backend uses full snapshots with correct behavior.
- [ ] Compare bytes, DOM rebuilds, and latency with step-01 fixtures at 1/16/64
  frames; publish actual results, including cases where snapshots still win.

Review slices: response contracts; coherent backend delta; controller install
and fallback; render invalidation; loss/restart and transfer-budget tests.
