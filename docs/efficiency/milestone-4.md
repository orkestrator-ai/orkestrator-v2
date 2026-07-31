# Milestone 4 — Gateway replay and revision-aware synchronization

Status: Implemented; manual soak verification pending

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

- [x] Define a small authoritative revision manifest.
- [x] Include projects, config, environments, pipelines, prompt queues,
      sessions, and reviews.
- [x] Add other resources only when they currently participate in broad sync.
- [x] Track client-known revisions.
- [x] Make snapshot commands return unchanged without a full body when the
      client revision matches.
- [x] Hydrate only resources whose revisions differ.
- [x] Treat generation changes as a full manifest invalidation.

### Polling migration

- [x] Keep the existing broad 60-second sweep during development and initial
      rollout.
- [ ] Compare broad-sweep results with replay/manifest results during soak.
- [ ] Confirm all inactive-environment resources converge.
- [x] Replace broad transfer with a slower manifest check and targeted
      hydration. Automated and manual equivalence verification remain tracked
      separately below.
- [x] Keep an explicit full-reconcile action for diagnosis and recovery.

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
- [x] Resource manifest returns stable revisions for unchanged state.
- [x] Conditional snapshot commands return unchanged without their bodies.
- [x] Backend restart invalidates old manifest revisions.
- [x] Backend restart converges the renderer stores through the command and
      manifest boundaries.
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
- [x] Stable clients use manifest checks instead of broad snapshot transfer.
- [ ] Inactive/background clients converge every authoritative resource.
- [x] An explicit full reconciliation remains available.
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
- `requestResourceResync()` remains the explicit authoritative full-reconcile
  path. Automatic initial attach, revision-gap, reconnect, and periodic paths
  now use the manifest instead.
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

### 2026-07-31 — revision manifest and targeted hydration slice

- The backend exposes a process-generation-scoped manifest for the eleven
  persistent snapshots that participated in broad synchronization: projects,
  environments, sessions, config, Kanban, project notes, feature plans, pane
  layouts, looped reviews, build pipelines, and prompt queues.
- Revisions are opaque 128-bit values derived from file metadata, not file
  contents. The atomic JSON writer installs a fresh inode on each commit, so the
  manifest detects writes made by this backend and by another backend sharing
  the data directory without reading prompts, notes, or other user data.
- A client sending the current generation and revisions receives an empty
  revision delta. The stable safety check therefore transfers one small
  manifest every five minutes and no resource snapshots.
- Existing snapshot commands preserve their legacy response shape. When callers
  supply `knownManifestGeneration` and `knownResourceRevision`, projects,
  config, environment snapshots, sessions, pane layouts, looped reviews, build
  pipelines, prompt queues, Kanban, project notes, and feature plans return an
  `unchanged` envelope without reading or returning the body.
- The renderer acknowledges revisions only after the corresponding hydration
  handler completes successfully. An unsuccessful hydration leaves that
  revision unacknowledged so a later manifest check can retry it. Generation
  resets hydrate projects first, environments second, and dependent resources
  last. Project and environment manifest hydration is owned by the global store
  binding rather than the sidebar hooks, so a closed mobile drawer cannot omit
  a newly discovered scope before dependent stores are reconciled.
- The former broad one-minute sweep is replaced by a five-minute manifest
  check. Replay misses and generation changes use the same targeted path;
  explicit full reconciliation is retained for diagnosis and recovery.
- Existing automated coverage exercises stable revisions, cross-process writes,
  the storage-level body-less snapshot helper, storage restart invalidation,
  renderer generation-reset ordering, changed-resource-only hydration,
  failed-hydration retry, and the existing resource binding and replay
  behavior. New command-registry cases exercise manifest validation, paired and
  malformed cursor handling, legacy responses, and changed and unchanged
  envelopes for all eleven manifest-backed commands. A renderer integration
  case now carries a generation change through two real `StorageService`
  instances, the real command registry, manifest reconnect handling, and the
  final project and environment stores. Manual multi-environment,
  constrained-network, and iOS background/foreground soak verification remains
  open.
- Passing follow-up checks:
  - all seven TypeScript project typechecks (web, web-public, backend, desktop,
    protocol, Codex bridge, and Claude bridge)
  - `bun run build` (four Turbo build tasks)
  - backend native-session storage/service focus (151 tests)
  - backend resource manifest storage focus (25 tests)
  - protocol resource manifest focus (23 tests)
  - command registry focus (352 passed, 1 skipped)
  - renderer resource/store synchronization focus (97 tests)
  - renderer `App` focus (51 tests)
  - project/environment hook focus (44 tests)
  - isolated root suite (3,576 passed, 1 skipped)
  - `bun run test`: workspace, root, bridge, protocol-lockfile, and iOS groups
    passed; the iOS simulator group executed 40 tests
- The full-suite run is signed off. The combined exit criterion remains open
  only for the manual soak checks listed above.
