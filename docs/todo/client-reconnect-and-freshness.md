# Client reconnect and freshness

Checked against `main` at `2459b05c` (2026-10-15).

This covers how clients behave across disconnects and staleness: how a
read-only stream comes back after an outage, and what a view tells the user
while its data may be behind. A shared jittered reconnect policy exists, but
three transport owners still retry on fixed or unjittered ladders, so an
outage can keep every tab and bridge retrying in lock-step. Event-led views
already track whether they are current, stale, degraded or unsupported, and
the container fetch policy tracks remote freshness, but none of this reaches
the UI, and the read coordinator never hears that a transport is down.

## Current state

### Reconnect

- `packages/protocol/src/reconnect-backoff.ts` is policy only:
  `reconnectDelayMs` (exponential, capped, equal jitter from an injected
  random source) and `ReconnectBackoff`, which resets the ladder only after a
  connection stayed up for `healthyAfterMs`. It is for read and stream
  recovery only.
- Adopted by the web gateway main stream (`mainStreamBackoff` in
  `apps/web/src/lib/native/web-gateway.ts`: first retry
  `EVENT_RECONNECT_DELAY_MS` 2 s, capped at 8 times that) and by the OpenCode
  event monitor (`apps/backend/src/core/opencode-observation-stream.ts`). The
  cookie-mode `EventSource` uses the same backoff once it is CLOSED.
- Terminal WebSocket client (`apps/web/src/lib/native/terminal-websocket-client.ts`):
  `fallbackAndReconnect` and `scheduleSubscribe` use
  `min(10 s, 500 ms * 2^min(n, 5))` with no jitter.
- Gateway terminal fallbacks in `web-gateway.ts`
  (`scheduleBrowserTerminalReconnect` with `browserTerminalReconnectTimer`, and
  the per-stream `stream.reconnectTimer` in the fetch fallback) retry at the
  constant `eventReconnectDelayMs`. Every reopen announces a desync, which
  forces a terminal snapshot. #968 rewrote the stream core and #986 added
  explicit input resume; both kept these timers.
- Codex `ProcessSupervisor.startWithRetry`
  (`bridges/codex-bridge/src/app-server/process-supervisor.ts`) retries with
  jitter over `DEFAULT_BACKOFF_MS` (250 ms to 10 s). After
  `DEFAULT_CIRCUIT_THRESHOLD` (5) failures within 60 s it sets `circuitOpen`,
  which is never cleared, and its backoff `sleep` cannot be cancelled: shutdown
  waits out the current delay.
- Claude, Pi and Cursor have no transport reconnect loops. ACP's
  `requestPromptWithRetriableProviderRetries` re-sends a continuation prompt,
  so it is not a read retry and is out of scope.

### Freshness

- `createBoundedHydration` (`apps/web/src/lib/bounded-hydration.ts`) reports a
  `HydrationStatus` (`idle`, `hydrating`, `current`, `stale`, `degraded`,
  `unsupported`). It is mirrored as `syncStatus` into `prMonitorStore`,
  `environmentDiffStore` and `worktreeSnapshotStore`, and no component reads it.
- `WorktreeSnapshotState.remote` (`WorktreeRemoteFreshness` in
  `packages/protocol/src/worktree-snapshots.ts`: `not-required`, `current`,
  `stale`, `unknown`, plus `lastSuccessAt` and `failure`) is published for
  containers and not rendered.
- PR `lastSuccessfulCheckAt` is used only for store equality in
  `prMonitorStore.ts`.
- `ReadCoordinator.setDisconnected()` (`apps/web/src/lib/read-coordinator.ts`)
  has no caller, so "pause while the transport is known disconnected" never
  triggers. The coordinator does hear confirmed reconnects
  (`notifyReadCoordinatorReconnected` from `resource-sync.ts`) and server
  switches (`setReadCoordinatorConnection` from `App.tsx`). The web gateway
  exposes no connection-state signal today; it only logs disconnects.
- The coordinator panel remembers the legacy capability per mount (`legacyRef`
  in `apps/web/src/components/projects/useCoordinatorPanelData.ts`) and does
  not re-probe after a server switch within that mount.

## Outstanding work

### Code

1. Adopt `reconnectDelayMs` with an injected random source in the terminal
   WebSocket client for both the socket reconnect and denied-subscription
   retries. Update the exact-delay test "backs off repeatedly denied
   subscriptions instead of polling at a fixed interval" in
   `terminal-websocket-client.test.ts`.
2. Back off the gateway terminal fallback timers with `ReconnectBackoff`,
   resetting only after a healthy stream. Each reopen costs a desync snapshot,
   so a fixed 2 s retry during an outage is the expensive case.
3. Decide whether the Codex breaker should close after a healthy period or a
   quiet interval, and make the backoff sleep cancellable so shutdown does not
   wait for it.
4. Give the read coordinator a disconnect signal. Expose connected and
   disconnected state from the web gateway main stream and the desktop
   transport, and call `setDisconnected(true)` and `setDisconnected(false)`
   from it.
5. Show freshness in the UI:
   - stale, degraded and unsupported state for the PR, diff-badge and Files
     views, from `syncStatus`;
   - container remote freshness from `remote`, where `stale` means "exact
     against the clone's refs, which may be behind the remote", never
     "unusable";
   - optionally the last successful PR check time.
6. Reset the coordinator panel's `legacyRef` when the active connection
   changes.

### Qualification

- An outage workload (backend restart and a dropped tailnet link) with
  several tabs and terminals open, showing that reconnects spread out instead
  of retrying in lock-step. Today only deterministic ladder tests exist
  (`reconnect-backoff.test.ts`, `web-gateway-reconnect.test.ts`,
  `opencode-provider-reconnect.test.ts`).
- Real-browser checks that freshness indicators appear on disconnect, clear
  after reconnect, and do not flicker on a quiet `unchanged` safety read.
- Exact terminal recovery under backpressure, re-run after items 1 and 2.

## Constraints and rationale

- Keep the replay cursor, subscribe-before-replay, the connected frame's
  cursor echo and terminal desync recovery. Recovering a stream never
  resubmits an ambiguous prompt or approves an interaction.
- `ReconnectBackoff` drives read and stream recovery only, never prompt,
  approval or write retries.
- One reconnect timer per owner. The first retry stays responsive; only a
  connection that stayed healthy resets the ladder.
- Browser `offline` is deliberately not treated as disconnected: a local
  desktop backend stays reachable without internet. `online` only triggers a
  reconcile.
- A freshness indicator must not imply a new measurement after a failed read;
  stale data keeps its original `observedAt`.
- Keep the existing heartbeats: the gateway's `KEEPALIVE_MS` (25 s) also
  advances the stream cursor, Claude's SSE sends every 30 s, and Codex checks
  every 5 s and sends at 5 s active and 30 s idle.
- Any polling reduction that relies on bounded hydration must cite its fault
  coverage and add rows for its own view. Current coverage:
  - `apps/web/src/lib/bounded-hydration.test.ts`: event before subscription,
    event during a snapshot, repeated reconnects during a snapshot, a late
    older snapshot, duplicates, out-of-order gaps, generation reset, a lost
    final event, replay expiry, filtered stream cursors, deletion and
    recreation, buffer overflow, invalid payloads, snapshot timeouts,
    unsupported capability and transport switch;
  - `apps/web/src/hooks/usePrMonitorService.test.tsx` and
    `useEnvironmentDiffStats.test.tsx`: the same at hook level, a revision gap
    turning into one conditional read, and PR transitions toasting once;
  - `apps/web/src/lib/resource-sync.test.ts`: the safety-check cadence;
  - `apps/backend/tests/view-revisions.test.ts` and
    `apps/backend/src/core/commands-state-sync.test.ts`: backend stamping and
    compact conditional reads.

## Open questions

- Should the Codex breaker reset at all, or stay a permanent failure until the
  bridge restarts, with only the sleep made cancellable?
- Where should the freshness indicators live: per view, or one connection
  banner plus per-view detail?

## Related

- [remote-client-bandwidth.md](remote-client-bandwidth.md): remote transport
  measurement, which shares the outage and slow-client workloads.
- [native-agent-idle-observation.md](native-agent-idle-observation.md):
  observation invalidations and the read coordinator's native views.
- [recurring-work-qualification.md](recurring-work-qualification.md): the
  wider real-stack and two-client QA.
- `../architecture/event-snapshot-recovery.md` (sequence semantics, supported
  peers, `remote` freshness) and `../architecture/remote-gateway.md`.
- Living-doc drift to fix:
  - `event-snapshot-recovery.md` links recurring-processes plan step 11 in its
    header and uses "step NN" labels throughout (the "Supported peers" table
    says "Before step 11"). Its "Adopting the contract" step 5 points at "the
    plan's recovery coverage list" and the coordinator section at "step 09's
    completion notes"; inline the coverage list above and drop both pointers.
  - `remote-gateway.md` does not describe reconnect behaviour or the 25 s
    keepalive that also advances the cursor.

## Replaces

- `docs/improvements/recurring-processes/plan/10-bridge-and-transport-lifecycle.md`
  (remaining transports and their deferrals; the native chat-store ladder it
  listed was deleted in #970)
- `docs/improvements/recurring-processes/plan/11-recovery-and-resource-bounds.md`
  (`syncStatus` not rendered, real-browser QA, the recovery coverage list)
- `docs/improvements/recurring-processes/plan/06-client-read-coordination.md`
  (`setDisconnected` has no caller)
- `docs/improvements/recurring-processes/plan/04-container-git-fetch-policy.md`
  (no client renders `remote`)
- `docs/improvements/recurring-processes/plan/09-secondary-client-processes.md`
  (coordinator legacy capability per mount)
