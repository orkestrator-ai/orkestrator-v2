# Milestone 4 — Gateway replay and revision-aware synchronization

Status: Not started

Depends on: Milestone 3

Unblocks: Milestone 5

## Outcome

Replace frequent broad snapshot transfer with bounded gateway replay and cheap
resource revision checks while retaining explicit authoritative reconciliation.

## Scope

Primary areas:

- `apps/backend/src/gateway.ts`
- gateway event ring and cursor parsing
- `apps/web/src/lib/native/web-gateway.ts`
- resource synchronization stores and hooks
- conditional backend snapshot commands
- gateway and inactive-environment tests

## Implementation checklist

### Gateway event identity

- [ ] Create a gateway generation identifier.
- [ ] Assign a monotonically increasing revision to every authoritative
      non-terminal event within that generation.
- [ ] Emit the revision as the SSE `id`.
- [ ] Accept `Last-Event-ID`.
- [ ] Accept an explicit `since` query for clients that cannot set the header.
- [ ] Validate cursor syntax and generation.
- [ ] Keep terminal byte events out of the main authoritative replay ring.

### Bounded replay

- [ ] Bound the ring by frame count.
- [ ] Bound the ring by encoded bytes.
- [ ] Release retained payloads according to a documented idle policy.
- [ ] Subscribe before calculating replay.
- [ ] Buffer events emitted during replay calculation.
- [ ] Flush replayed frames, then only buffered frames newer than the replay
      range.
- [ ] Echo the client's cursor on the connected frame.
- [ ] Never anchor the connected frame at the latest revision before replay.
- [ ] Emit `reconcile-required` for an expired, invalid, or prior-generation
      cursor.
- [ ] Preserve bounded slow-consumer behavior during handshake and replay.

### Revision manifest and conditional hydration

- [ ] Define a small authoritative revision manifest.
- [ ] Include projects, config, environments, pipelines, prompt queues,
      sessions, and reviews.
- [ ] Add other resources only when they currently participate in broad sync.
- [ ] Track client-known revisions.
- [ ] Make snapshot commands return unchanged without a full body when the
      client revision matches.
- [ ] Hydrate only resources whose revisions differ.
- [ ] Treat generation changes as a full manifest invalidation.

### Polling migration

- [ ] Keep the existing broad 60-second sweep during development and initial
      rollout.
- [ ] Compare broad-sweep results with replay/manifest results during soak.
- [ ] Confirm all inactive-environment resources converge.
- [ ] Replace broad transfer with a slower manifest check and targeted hydration
      only after equivalence is proven.
- [ ] Keep an explicit full-reconcile action for diagnosis and recovery.

## Required tests

- [ ] Replay a short valid gap without snapshot hydration.
- [ ] Expired cursor produces exactly one reconciliation path.
- [ ] Invalid cursor and prior generation reconcile.
- [ ] Replay ring count and byte bounds hold during a burst.
- [ ] Event emitted between subscribe and replay calculation is not lost.
- [ ] Disconnect during handshake does not skip replay on reconnect.
- [ ] Connected frame echoes the client cursor.
- [ ] Terminal output does not enter the main replay ring.
- [ ] Resource manifest returns stable revisions for unchanged state.
- [ ] Conditional snapshot returns unchanged without its body.
- [ ] Backend restart invalidates old cursors and converges.
- [ ] Slow clients cannot make handshake buffers unbounded.

## Manual verification

- [ ] Interrupt the network briefly and verify replay without broad hydration.
- [ ] Hold a client offline until its cursor expires and verify one reconcile.
- [ ] Restart the gateway and verify generation recovery.
- [ ] Run multiple environments while viewing another project.
- [ ] Background and foreground iOS after both a short and expired gap.
- [ ] Verify projects, environments, pipelines, prompts, sessions, approvals,
      interactions, reviews, and terminal output.
- [ ] Confirm a stable client no longer downloads broad snapshots each minute.

## Commands

```bash
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
bun test tests/unit/electron/gateway.test.ts --parallel
bun test tests --parallel
bun run test
```

## Exit criteria

- [ ] Replay succeeds for retained gaps without broad hydration.
- [ ] Expired and prior-generation cursors reconcile explicitly.
- [ ] Replay and handshake memory are bounded.
- [ ] Subscribe-before-replay races are covered.
- [ ] Stable clients use manifest checks instead of broad snapshot transfer.
- [ ] Inactive/background clients converge every authoritative resource.
- [ ] An explicit full reconciliation remains available.
- [ ] Focused tests, typechecks, soak checks, and the full suite pass.

## Evidence and decisions

Record:

- ring frame, byte, and retention bounds;
- replay hit, expiry, and reconciliation rates;
- stable-client requests and bytes before/after;
- background duration tested on iOS;
- broad-sweep equivalence/soak period;
- final manifest interval;
- test command results.

No evidence recorded yet.
