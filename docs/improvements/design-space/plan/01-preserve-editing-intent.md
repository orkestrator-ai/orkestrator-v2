# 01 — Preserve editing intent

Status: Planned.  
Dependencies: none.  
Findings: R1, R2.  
Next: [02 — Operation contracts and durability](02-operation-contracts-and-durability.md).

## Outcome

A user action is applied to the frame/element revision the user saw, or it is
explicitly rejected with the draft retained. Moving and resizing a frame while
another request is slow must not silently discard either action. Ship this
localized correction before introducing storage or UX redesigns.

## Existing owners

- `apps/web/src/components/design/DesignCanvasTab.tsx`: revision substitution,
  mutation callbacks, snapshot refresh, error state.
- `apps/web/src/components/design/latest-mutation-queue.ts` and its tests:
  currently one replaceable pending request per frame.
- `apps/web/src/components/design/DesignFrameView.tsx`: gesture start revision,
  selection, preview, resize callbacks.
- `e2e/DesignCanvas.spec.ts` and its fixture: real runtime and backend conflict
  coverage; extend with deterministic race barriers rather than fixed sleeps.
- `apps/backend/src/core/design-service.test.ts`: existing backend CAS behavior
  is a constraint to preserve, not a workaround target.

## Implementation work

### 1. Reproduce the two distinct faults

- [ ] Add an integration case that selects element B at revision N, begins a
  resize, inserts a sibling from another writer, delivers revision N+1, then
  ends the original gesture. Assert neither the replacement target nor the
  original target is unexpectedly modified.
- [ ] Repeat with the selector operation waiting behind a deliberately blocked
  mutation. This protects the delayed-dispatch path as well as pointerup.
- [ ] Add a queue test with a blocked operation on frame A and separate move
  and resize intents on frame B. Assert both outcomes, not only execution count.
- [ ] Establish small benchmark fixtures for 1/16/64 frames, small/near-limit
  documents, cold/warm Chromium, and slow responses. Record current bytes,
  render counts, queue delay, and disk writes using synthetic content. These
  fixtures support later steps; do not require a full performance framework.

### 2. Preserve author preconditions

- [ ] Remove unconditional substitution of `expectedRevision` in the mutation
  worker. Carry `baseFrameRevision`, selector/identity, and gesture ID from the
  start of the interaction through dispatch.
- [ ] On a changed revision, fail the old intent through the normal conflict
  path. Keep draft values and expose Reselect/Discard; do not ask the backend
  to try the old selector against a new document.
- [ ] Before server support exists for proven predecessor chaining, prefer a
  visible conflict over a guessed rebase. Later steps improve continuation
  without weakening this rule.
- [ ] Ensure pointer cancel and Escape discard only a not-yet-submitted gesture.
  They must not label a request already written to the backend as canceled.

### 3. Replace resource-only coalescing

- [ ] Introduce a typed intent descriptor containing target frame, operation
  kind, gesture ID, base revision, and changed property set.
- [ ] Collapse repeated unsent samples from the same absolute move gesture or
  the same resize gesture. The final sample contains the complete intended
  value for that gesture.
- [ ] Preserve order between distinct gestures and operation families. A
  style edit cannot replace a move; a resize cannot erase a pending move.
- [ ] Do not accumulate relative keyboard increments as if they were absolute
  values. Accumulate them within one local gesture before sending, or retain
  their ordered semantics explicitly.
- [ ] Stop draining dependent intents after a conflict until they are
  reconciled/reviewed. Continue independent frames when safe, and report their
  individual statuses rather than presenting one global success flag.
- [ ] Catch queue-drain failures at the owning boundary so a callback exception
  cannot become an unhandled rejection. Always settle busy state.

### 4. Correct completion bookkeeping without a large refactor

- [ ] Consume successful mutation responses as acknowledged frame/canvas
  revisions. Do not wait for an event to know that this client's request won.
- [ ] Do not advance a whole-canvas cursor over an unseen concurrent change in
  another frame merely because one response contains a newer canvas revision.
  Mark the projection incomplete and reconcile as necessary.
- [ ] Return a promise for the actual active refresh cycle and its requested
  follow-up, rather than returning immediately when `running` is true.
- [ ] Keep an explicit failed/pending state until reconciliation completes;
  preserve errors from one operation when another succeeds.

## Race test matrix

| Scenario | Expected result |
| --- | --- |
| Agent structural edit arrives before pointerup | Original selector edit conflicts; no different element changes |
| Agent edit arrives while user request is pending locally | Same precondition retained at eventual dispatch |
| Move then resize while frame A is blocked | Both survive or each has an explicit conflict; neither disappears |
| Two samples from one move gesture | Only newest unsent sample is submitted |
| Independent frames finish in different orders | Authoritative results retained without cursor skipping |
| Refresh overlaps a mutation response | Awaiters resolve after needed reconciliation, not before |
| Pointer cancel before submission | No backend mutation |
| Backend rejects a queued intent | Later dependent intent pauses; busy indicator settles |

Run the existing focused design backend and web files, then the browser
regressions through the repository workflow. Use fake deferred promises for
unit ordering; use backend barriers for browser races. Avoid timing-dependent
assertions such as hoping an agent edit lands during a 100 ms sleep.

## Acceptance and review slices

- [ ] First PR: regression cases plus precondition preservation.
- [ ] Second PR: typed queue semantics, individual outcomes, and awaitable
  refresh behavior. Existing successful edit, capture, and inactive-tab tests
  remain green.
- [ ] Document benchmark fixture metadata and baseline results without treating
  a single machine's timings as universal thresholds.
- [ ] No backend CAS relaxation, automatic conflict retry, or portable-file
  format change is introduced.

This step may still surface more explicit conflicts during rapid editing than
the final experience. That is acceptable until steps 02/03 add safe sequencing.
It must not silently drop or redirect intent in order to hide those conflicts.
