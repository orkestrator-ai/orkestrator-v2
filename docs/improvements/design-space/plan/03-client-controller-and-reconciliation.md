# 03 — Client controller and reconciliation

Status: Planned.  
Dependencies: [02](02-operation-contracts-and-durability.md).  
Findings: R1, R2, E1.

## Outcome

Canvas components consume one shared projection and operation state per
backend/environment/canvas. Repeated views do not create conflicting queues.
Switching tabs cannot abandon accepted mutations, and returning explains both
the latest document and any unsubmitted or uncertain user intent.

## Ownership and file changes

- Extract a proposed `design-controller.ts` from `DesignCanvasTab.tsx` and a
  bounded `designStore.ts` following existing per-resource store conventions.
- Keep transport calls in `design-client.ts`; capability detection and response
  decoding belong there rather than in JSX.
- Keep authoritative descriptors/receipts in step 02's backend service. Client
  draft persistence should reuse `compose-draft-persistence`/storage patterns
  where appropriate, with its own design schema and byte bounds.
- Make `DesignCanvasTab`, `DesignInspector`, and `DesignFrameView` subscribers
  and intent producers. Do not put backend execution in an effect cleanup.

## State model

Use a key containing backend connection identity, environment ID, and canvas
ID. Identical UUIDs on separate backends must not share state.

| State axis | Values and meaning |
| --- | --- |
| Snapshot | absent, loading, current, stale, deleted, invalid |
| Connection | connected, reconnecting, offline, unauthorized |
| Local intent | draft, preparing, prepared, submitting, admitted |
| Outcome | queued, executing, committed, rejected, canceled, interrupted, unknown |
| UI activity | separate edit/export/import/history busy indicators |

Only current committed snapshots answer “saved in workspace.” Local overlays
are labeled pending. Errors attach to the relevant operation/frame; a later
success must not clear an unrelated failure. Readiness is distinct from
connection state and from snapshot existence.

## Controller implementation

- [ ] Provide acquire/release subscription semantics and stable selectors.
  Activation subscribes to hints before obtaining the authoritative snapshot.
- [ ] Start with full snapshots and the existing cursor check. Store generation
  and applied revision together; reject regressions within one generation.
  A new generation forces authoritative replacement, even if a recovered
  document has a lower revision than the old projection.
- [ ] Coalesce refresh triggers into one in-flight promise with a dirty flag.
  A caller awaiting reconciliation through revision N resolves only after N
  or an explicit reset/error, never merely after setting the dirty flag.
- [ ] Guard late responses by controller identity/request epoch. A response
  from the previous environment/backend must not replace the new view.
- [ ] Apply an operation result as a complete projection update only when its
  base revision is contiguous. Otherwise update operation acknowledgment,
  mark the projection stale, and fetch a snapshot.
- [ ] Share one hint listener/cursor check per active canvas key. With zero
  visible consumers, stop presentation polling; accepted backend work remains
  alive. Keep only bounded state necessary to settle pending operations.
- [ ] Retry reads with bounded exponential backoff and jitter on disconnection;
  authentication loss goes through the existing gateway login behavior.
- [ ] Dispose inactive clean caches by count and bytes, using the index budget.
  Never evict a token/draft whose unknown outcome still needs reconciliation
  without persisting it and making it discoverable on reopen.

## Mutation submission and sequencing

1. Validate local intent, retain the observed version, and show a pending preview.
2. Prepare the backend descriptor. Persist the returned operation token before
   executing; an unsaved token is not eligible for automatic execution.
3. Execute once; store accepted state and use status/snapshot reconciliation
   when the response is lost. Do not prepare a fresh operation automatically.
4. Consume the terminal receipt. Remove the pending overlay only after the
   corresponding committed revision is installed, or after an explicit rejection.
5. Resolve dependent intents by proof, not by replacing their base revision
   with whatever happens to be newest.

- [ ] For compatible same-client nonstructural intent chains, carry a predecessor
  operation reference. The backend may substitute that predecessor's result
  only if the current frame still equals it and the operation kind permits it.
- [ ] Selector intents require unchanged structure identity and a verified
  target in addition to the allowed predecessor. External intervening edits
  result in conflict even if the selector still matches something.
- [ ] Pause dependent operations on rejection/unknown outcome; independent
  frames can continue within bounded capacity.
- [ ] Do not replay restored unsent drafts automatically after app restart.
  Offer Resume draft using its original base, or review against a fresh snapshot.
- [ ] A user discard clears their local intent; it does not claim that accepted
  backend work was canceled. Expose cancel-before-execution distinctly.

## User feedback

Show Saving in workspace only for admitted edits, Saved in workspace for a
verified committed revision, and Needs review for conflicts/unknown outcomes.
Provide concise operation-specific Retry read, Reselect, Discard draft, or
Cancel queued edit actions. Avoid a generic Refresh button as the only path.
The footer may expose revision details without requiring users to understand
them to recover.

## Tests and acceptance

- [ ] Mount two views of one canvas: one projection/listener, coherent selection
  updates, no duplicate writes.
- [ ] Submit edit, switch tabs/environments, let it finish, return: correct
  document and no permanent spinner or missing error.
- [ ] Lose the execute response after commit, reload, and reconcile the token:
  no duplicate mutation and no false “failed to save.”
- [ ] Restart before execute: retained prepared draft is not unexpectedly run.
- [ ] Deliver snapshots/hints out of order; simulate generation reset with a
  lower recovered revision; verify convergence.
- [ ] Interleave writes to two frames; acknowledging one must not skip the other.
- [ ] Evict clean inactive projections, then return: snapshot restores content.
- [ ] Controller/key changes cannot apply responses to a different environment.
- [ ] Gateway auth lapse pauses/re-authenticates through existing app behavior.
- [ ] Per-operation errors survive unrelated successful reads/writes.

Review in slices: controller extraction with behavior parity; awaitable sync
and stale-response tests; new mutation flow; durable token/draft recovery; UI
status states. Retain the old backend fallback until step 15 compatibility QA.
