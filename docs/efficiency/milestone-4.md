# Milestone 4 — Gateway replay and revision-aware synchronization

Status: In progress — gateway replay transport implemented

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

- [x] Create a gateway generation identifier.
- [x] Assign a monotonically increasing revision to every authoritative
      non-terminal event within that generation.
- [x] Emit the revision as the SSE `id`.
- [x] Accept `Last-Event-ID`.
- [x] Accept an explicit `since` query for clients that cannot set the header.
- [x] Validate cursor syntax and generation.
- [x] Keep terminal byte events out of the main authoritative replay ring.

### Bounded replay

- [x] Bound the ring by frame count.
- [x] Bound the ring by encoded bytes.
- [x] Release retained payloads according to a documented idle policy.
- [x] Subscribe before calculating replay.
- [x] Buffer events emitted during replay calculation.
- [x] Flush replayed frames, then only buffered frames newer than the replay
      range.
- [x] Echo the client's cursor on the connected frame.
- [x] Never anchor the connected frame at the latest revision before replay.
- [x] Emit `reconcile-required` for an expired, invalid, or prior-generation
      cursor.
- [x] Preserve bounded slow-consumer behavior during handshake and replay.

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

- [x] Replay a short valid gap without snapshot hydration.
- [x] Expired cursor produces exactly one reconciliation path.
- [x] Invalid cursor and prior generation reconcile.
- [x] Replay ring count and byte bounds hold during a burst.
- [x] Event emitted between subscribe and replay calculation is not lost.
- [x] Disconnect during handshake does not skip replay on reconnect.
- [x] Connected frame echoes the client cursor.
- [x] Terminal output does not enter the main replay ring.
- [x] A scoped stream's cursor advances past revisions its filter omitted.
- [x] An undeliverable replay window reconciles instead of dropping the client.
- [x] A throw mid-handshake unregisters the client and releases the gauge.
- [ ] Resource manifest returns stable revisions for unchanged state.
- [ ] Conditional snapshot returns unchanged without its body.
- [ ] Backend restart invalidates old cursors and converges.
- [x] Slow clients cannot make handshake buffers unbounded.

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

- [x] Replay succeeds for retained gaps without broad hydration.
- [x] Expired and prior-generation cursors reconcile explicitly.
- [x] Replay and handshake memory are bounded.
- [x] Subscribe-before-replay races are covered.
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

### 2026-07-30 — gateway replay transport slice

- Gateway generations are random 128-bit hexadecimal identifiers. Cursors use
  `<generation>:<revision>` and are validated before they can be echoed as an
  SSE `id`.
- The authoritative ring retains at most 2,048 frames or 2 MiB of encoded SSE,
  whichever is reached first. It releases retained payloads after five minutes
  without an authoritative event while preserving the issued revision. The byte
  bound is deliberately a quarter of the 8 MiB per-client hard buffer: replay is
  one synchronous flush and `writableLength` cannot fall during it, so a window
  sized at the hard limit would leave no room to land. A window that still will
  not fit reconciles (`replay-too-large`) rather than being destroyed partway
  through delivery.
- The per-connection replay-handshake buffer is independently capped at 2,048
  frames and 8 MiB. Overflow disconnects the client so its next request follows
  replay or explicit reconciliation rather than silently dropping state.
- Terminal output stays on its existing generation/revision snapshot path and
  is not retained in the gateway ring.
- The browser adapter carries the last cursor on direct-fetch reconnects and
  lets native `EventSource` use `Last-Event-ID`. A retained replay does not emit
  the renderer's broad-resync signal; fresh, invalid, expired, and
  prior-generation paths still do.
- When an automatic `EventSource` retry supplies both its original `since`
  query and a newer `Last-Event-ID`, the browser-owned header wins. The browser
  owns that header and always advances it, so a header *behind* the query means
  the query is the untrustworthy one; preferring the header re-delivers rather
  than skips. A blank value in either position means "no cursor", not a
  malformed one. An invalid cursor never receives a replacement SSE id until
  `reconcile-required`, so a disconnect between handshake frames cannot skip
  required hydration.
- Reconciliation reasons are distinct rather than collapsed onto
  `cursor-expired`: `cursor-ahead` and `invalid-cursor` mean the client sent
  something the gateway never issued, and `replay-too-large` means the gap was
  retained but undeliverable. Conflating them would hide a corrupt cursor behind
  a routine ring overrun.
- A scoped (`?events=`) stream receives no SSE id for events its filter omits,
  so its cursor is advanced with a single coalesced `gateway.cursor` frame on
  the keepalive tick. Without it the cursor freezes under unrelated traffic and
  every reconnect reconciles a gap the client never actually missed. Terminal
  streams are excluded — they never enter the cursor sequence at all.
- `/metrics` reports handshake outcomes (`fresh`, `caughtUp`, `replayed`,
  `replayedFrames`, `reconciled`, per-reason counts) and ring occupancy under
  `replay`. Eviction is otherwise invisible: a ring dropping every gap looks
  identical to one that never had to retain anything. This is the
  replay-hit/expiry/reconciliation-rate evidence this milestone asks for. The
  endpoint's body now routinely exceeds the 1 KiB compression floor and is
  compressed like any other dynamic body.
- The renderer's broad-resync suppression at boot is a one-second *window*, not
  a permanent flag. The desktop supervisor raises
  `native-event-stream-connected` while the backend starts, long before the
  renderer subscribes, so a `startResourceSync` closure that has never observed
  one is not necessarily at boot; treating its first announcement as the boot
  connect suppressed the refetch for a confirmed replay miss.
- A same-origin main `EventSource` that reaches `CLOSED` is now rebuilt from the
  retained cursor. Nothing else rebuilds it, and `ensureEventStream` early
  returns while one exists, so a fatal error previously stranded every
  authoritative event until the tab reloaded.
- The 60-second resource safety sweep remains enabled. Revision manifests,
  conditional snapshots, targeted hydration, equivalence soak, and iOS manual
  verification are the next slice.
- Baseline/after transfer evidence has not yet been recorded for this milestone.
- Passing focused checks:
  - `bun run --cwd apps/backend typecheck`
  - `bun run --cwd apps/web typecheck`
  - `bun run --cwd apps/desktop typecheck`
  - `bun test tests/unit/electron/gateway.test.ts --parallel` (156 tests)
  - `bun test --cwd apps/backend src/gateway-event-replay.test.ts --parallel`
    (28 tests)
  - `bun test src/lib/native/web-gateway.test.ts src/lib/resource-sync.test.ts --parallel`
    from `apps/web` (98 tests)
