# Client reconnect and freshness

Checked against `main` at `2459b05c` (2026-10-15).

This covers how clients behave across disconnects and staleness: how a
read-only stream comes back after an outage, and what a view tells the user
while its data may be behind. A shared jittered reconnect policy exists, but
two transport owners (the terminal WebSocket client and the Codex supervisor)
still retry on unjittered or never-closing ladders. Event-led views
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
- Adopted by every web gateway stream in
  `apps/web/src/lib/native/web-gateway.ts` through one policy
  (`createStreamBackoff`: first retry `EVENT_RECONNECT_DELAY_MS` 2 s, capped
  at 8 times that, healthy after `EVENT_STREAM_HEALTHY_AFTER_MS` 30 s), and by
  the OpenCode event monitor
  (`apps/backend/src/core/opencode-observation-stream.ts`). The gateway has
  one ladder per reconnect owner: `mainStreamBackoff` for the main stream,
  `browserTerminalBackoff` for the shared same-origin terminal `EventSource`,
  and `stream.backoff` for each direct terminal fetch stream. Cookie-mode
  `EventSource`s use it only once CLOSED; the browser retries a CONNECTING one
  itself. The main stream reopening retries any waiting terminal fallback at
  once (`retryWaitingTerminalFallbacks`). A tab becoming visible or the
  browser's `online` event retries the waiting main stream and terminal
  fallbacks at once (`retryWaitingStreams`); the gateway's disposer removes
  both listeners. `web-gateway-reconnect.test.ts` covers both stream kinds on
  a manual timer queue.
- Terminal WebSocket client (`apps/web/src/lib/native/terminal-websocket-client.ts`):
  `fallbackAndReconnect` and `scheduleSubscribe` use
  `min(10 s, 500 ms * 2^min(n, 5))` with no jitter. Its repeated
  `onFallbackRequired` calls no longer hurry the gateway's HTTP fallback,
  which waits for its own pending retry.
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
2. Decide whether the Codex breaker should close after a healthy period or a
   quiet interval, and make the backoff sleep cancellable so shutdown does not
   wait for it.
3. Give the read coordinator a disconnect signal. Expose connected and
   disconnected state from the web gateway main stream and the desktop
   transport, and call `setDisconnected(true)` and `setDisconnected(false)`
   from it.
4. Show freshness in the UI:
   - stale, degraded and unsupported state for the PR, diff-badge and Files
     views, from `syncStatus`;
   - container remote freshness from `remote`, where `stale` means "exact
     against the clone's refs, which may be behind the remote", never
     "unusable";
   - optionally the last successful PR check time.
5. Reset the coordinator panel's `legacyRef` when the active connection
   changes.

### Qualification

- An outage workload (backend restart and a dropped tailnet link) with
  several tabs and terminals open, showing that reconnects spread out instead
  of retrying in lock-step, and that terminals come back with the main stream.
  Run it for both terminal paths: a same-origin browser (shared `EventSource`)
  and a direct client (per-terminal fetch). Today only deterministic ladder
  tests exist (`reconnect-backoff.test.ts`, `web-gateway-reconnect.test.ts`,
  `opencode-provider-reconnect.test.ts`).
- Real-browser checks that freshness indicators appear on disconnect, clear
  after reconnect, and do not flicker on a quiet `unchanged` safety read.
- Exact terminal recovery under backpressure, re-run after item 1. The
  gateway terminal fallback backoff has landed, so the HTTP/SSE path can be
  re-run now.

## Constraints and rationale

- Keep the replay cursor, subscribe-before-replay, the connected frame's
  cursor echo and terminal desync recovery. Recovering a stream never
  resubmits an ambiguous prompt or approves an interaction.
- `ReconnectBackoff` drives read and stream recovery only, never prompt,
  approval or write retries.
- One reconnect timer per owner. The first retry stays responsive; only a
  connection that stayed healthy resets the ladder.
- Gateway terminal fallbacks:
  - They use the main stream's policy and options (`eventReconnectDelayMs`,
    `eventReconnectMaxDelayMs`, `eventReconnectRandom`, `eventReconnectNow`)
    rather than terminal-specific ones. That gives 2 s, then up to 16 s, with
    equal jitter. The first retry is never slower than the old fixed 2 s.
  - "Healthy" means open for 30 s, measured from `onopen` or the OK response.
    It is not "first frame received": an idle terminal sends no frames, and a
    server that sends one frame and then drops would reset the ladder every
    time.
  - Ladders are kept per owner. The shared same-origin socket has one ladder
    because it is one socket. Each direct terminal has its own because it has
    its own socket: a shared ladder would climb one step per terminal when a
    restart drops them all at once.
  - What skips the wait, without resetting the ladder (a failed early attempt
    waits for the next step):
    - the main stream opening, which retries every waiting fallback at once;
    - a new terminal stream: a mount, or the user's Reconnect, which
      re-listens;
    - the tab becoming visible, or the browser's `online` event, which retry
      the waiting main stream and every waiting fallback. A hidden tab's
      timers are throttled, and the outage may have ended mid-wait. This
      matches the read coordinator, which retries reads on `online`.
  - What does not skip it:
    - narrowing the shared filter;
    - the terminal WebSocket asking for fallback again.
  - Removing the last fallback terminal resets the shared ladder.
- Browser `offline` is deliberately not treated as disconnected: a local
  desktop backend stays reachable without internet. `online` only triggers a
  reconcile, and the gateway retries any stream waiting out its backoff.
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

- [0052-remote-client-bandwidth.md](0052-remote-client-bandwidth.md): remote transport
  measurement, which shares the outage and slow-client workloads.
- [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md):
  observation invalidations and the read coordinator's native views.
- [0048-recurring-work-qualification.md](0048-recurring-work-qualification.md): the
  wider real-stack and two-client QA.
- `../architecture/event-snapshot-recovery.md` (sequence semantics, supported
  peers, `remote` freshness) and `../architecture/remote-gateway.md`.
- Living-doc drift to fix:
  - `event-snapshot-recovery.md` links recurring-processes plan step 11 in its
    header and uses "step NN" labels throughout (the "Supported peers" table
    says "Before step 11"). Its "Adopting the contract" step 5 points at "the
    plan's recovery coverage list" and the coordinator section at "step 09's
    completion notes"; inline the coverage list above and drop both pointers.
  - `remote-gateway.md` ("Event stream reconnects") does not say that the
    25 s keepalive also advances the cursor.

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
