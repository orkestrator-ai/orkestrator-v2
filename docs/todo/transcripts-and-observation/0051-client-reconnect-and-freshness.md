# Client reconnect and freshness

Checked against `main` at `20f6de91` (2026-10-25). All five code items are
done; what is left is live qualification.

This covers how clients behave across disconnects and staleness: how a
read-only stream comes back after an outage, and what a view tells the user
while its data may be behind. Every reconnect owner now uses the shared
jittered policy, the Codex breaker closes again after a quiet cooldown, the
read coordinator pauses while a transport is known to be down, and stale,
degraded, unsupported and remote freshness reach the UI. None of it has been
exercised against a real outage yet.

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
- Terminal WebSocket client
  (`apps/web/src/lib/native/terminal-websocket-client.ts`): the socket has one
  `ReconnectBackoff` (`socketBackoff`: first retry 500 ms, cap 10 s, equal
  jitter, healthy after 30 s of `ready`). A deliberate foreground rebuild
  ends its health interval without counting a failure; going idle resets it.
  Denied subscriptions use `reconnectDelayMs` per channel (500 ms to 10 s),
  reset when the server accepts the subscription. The gateway hands it the
  same jitter source and clock as its event streams (`eventReconnectRandom`,
  `eventReconnectNow`). Its repeated `onFallbackRequired` calls do not hurry
  the gateway's HTTP fallback.
- Codex `AppServerSupervisor.startWithRetry`
  (`bridges/codex-bridge/src/app-server/process-supervisor.ts`) retries with
  jitter over `DEFAULT_BACKOFF_MS` (250 ms to 10 s). After
  `DEFAULT_CIRCUIT_THRESHOLD` (5) failures within 60 s the breaker opens for
  `DEFAULT_CIRCUIT_COOLDOWN_MS` (5 min). The next demand after that gets one
  half-open probe start with no retries: success closes the breaker, failure
  re-opens it at once with the cooldown doubled, up to
  `DEFAULT_CIRCUIT_MAX_COOLDOWN_MS` (30 min). The backoff sleep wakes on
  `stop()` (`sleepUnlessAborted` on `stopController`), so shutdown no longer
  waits it out.
- Claude, Pi and Cursor have no transport reconnect loops. ACP's
  `requestPromptWithRetriableProviderRetries` re-sends a continuation prompt,
  so it is not a read retry and is out of scope.

### Freshness

- The gateway exposes `eventStreamConnection` (`idle`, `connecting`,
  `connected`, `disconnected`; it stays `disconnected` through retries until a
  stream opens). `apps/web/src/lib/transport-connectivity.ts` combines it with
  Electron's connection list (the active remote `reconnecting` or
  `unreachable`, or Local no longer available) and calls
  `ReadCoordinator.setDisconnected(true/false)`. `App.tsx` starts it and feeds
  the connection list. Browser `offline` is still not an owner.
- `ConnectionStatusBanner` shows one app-wide notice once the transport has
  been down for 4 s and clears on reconnect.
- `syncStatus` (`stale`, `degraded`, `unsupported`) marks the View PR action
  (tooltip adds the last successful check time from `lastSuccessfulCheckAt`)
  and the legacy diff badge. The Files panel shows `stale`/`degraded` of its
  revision feed as delayed announcements (it still polls every 5 s) and
  nothing for `unsupported`. Texts are in `apps/web/src/lib/view-freshness.ts`.
- `worktreeSnapshotStore` now keeps `remote`; the Files panel's Changes tab
  shows `stale` as "Base may be behind remote" (exact against the clone's
  refs) and `unknown` as "Base not fetched yet".
- The coordinator panel keys its legacy capability to the read coordinator's
  connection generation (`legacyRef` in
  `apps/web/src/components/projects/useCoordinatorPanelData.ts`), so a server
  switch within one mount probes the view command again.
- The behaviour is described in `../../architecture/event-snapshot-recovery.md`
  ("Freshness in the UI") and `../../architecture/remote-gateway.md`.

## Outstanding work

### Code

All done on 2026-10-25:

1. ~~Terminal WebSocket jitter.~~ Done. Socket reconnect uses
   `ReconnectBackoff`, denied subscriptions use `reconnectDelayMs`, both with
   an injected random source. Evidence in `terminal-websocket-client.test.ts`:
   "backs off repeatedly denied subscriptions instead of polling at a fixed
   interval" (updated: the top of the jitter range is the old exact ladder
   100, 200, 400, 800, 800), "jitters denied-subscription retries so clients
   denied together spread out" (50 … 400, and the ladder resets once
   accepted), and "backs off socket reconnects with jitter and resets only
   after a healthy connection".
2. ~~Codex breaker and cancellable sleep.~~ Done: quiet-interval cooldown with
   a single half-open probe (see Assumptions and decisions), and a backoff
   sleep that `stop()` wakes. Evidence in `process-supervisor.test.ts`: "after
   a quiet cooldown one probe start closes the breaker", "a failed probe
   re-opens at once, without retries, for a doubled cooldown", "concurrent
   demand during a probe joins it instead of spawning twice", and "stop wakes
   a start that is waiting out its backoff" (a 60 s backoff, stop returns in
   well under 5 s).
3. ~~Read coordinator disconnect signal.~~ Done for both transports. Evidence:
   `transport-connectivity.test.ts` (owners combine, the coordinator's
   `getDiagnostics().disconnected` follows, a stream already down at start is
   adopted, `connectionListDisconnected` for Local and remote states) and the
   two "gateway main stream connection state" cases in
   `web-gateway-reconnect.test.ts` (same-origin `EventSource` with a browser
   retry and a fatal close; direct fetch stream across a failed retry).
4. ~~Show freshness in the UI.~~ Done, including the optional last successful
   PR check time. Evidence: `view-freshness.test.ts`,
   `ConnectionStatusBanner.test.tsx` (a blip inside the delay never shows; the
   banner clears at once on reconnect), `worktreeSnapshotStore.test.ts`, and
   the freshness cases in `ActionBar.test.tsx`, `EnvironmentItem.test.tsx` and
   `FilesPanel.test.tsx`.
5. ~~Reset the coordinator panel's `legacyRef` on a connection change.~~ Done.
   Evidence: "probes the view command again after a server switch within the
   same mount" in `useCoordinatorPanelData.test.tsx`, which fails against the
   old per-mount flag.

### Qualification

Not run: each needs a live stack this run did not have (see "Not verified"
below for why).

- An outage workload (backend restart and a dropped tailnet link) with
  several tabs and terminals open, showing that reconnects spread out instead
  of retrying in lock-step, and that terminals come back with the main stream.
  Run it for both terminal paths: a same-origin browser (shared `EventSource`)
  and a direct client (per-terminal fetch), and once with the terminal
  WebSocket enabled (`orkestrator-terminal-transport` = `websocket`), whose
  socket ladder is new. Today only deterministic ladder tests exist
  (`reconnect-backoff.test.ts`, `web-gateway-reconnect.test.ts`,
  `terminal-websocket-client.test.ts`, `opencode-provider-reconnect.test.ts`).
- Real-browser checks that the connection banner appears after 4 s of a real
  outage and clears after reconnect, that automatic reads pause meanwhile
  (`getReadCoordinator().getDiagnostics().disconnected`), and that the PR,
  diff-badge and Files indicators do not flicker on a quiet `unchanged`
  safety read. Include an Electron remote connection, whose signal is the
  connection list rather than the gateway stream.
- Exact terminal recovery under backpressure, re-run after item 1, on both the
  HTTP/SSE fallback and the WebSocket path.

## Not verified

- The qualification runs above. An agent-test (`dev:test`) browser session
  lapses whenever the backend restarts and is sent to the login page by
  design, so a backend restart cannot show the banner in that harness; the
  outage check needs a durable-token browser or a direct (bearer) client
  against a backend that is stopped and restarted, and the dropped tailnet
  link needs a second machine.
- The Codex breaker's cooldown and probe are proved only with a fake
  app-server child (`process-supervisor.test.ts`), not with a real `codex`
  binary that keeps failing to start.
- The 4 s banner delay and the 5 min / 30 min breaker cooldowns are reasoned
  defaults, not measured ones. Revisit them with the outage workload.

## Assumptions and decisions

1. **Codex breaker: does it close, and how?**
   - Options: (a) stay open until the bridge restarts and only make the sleep
     cancellable; (b) close after the next generation stays healthy for a
     while; (c) close after a quiet interval via one half-open probe.
   - Choice: (c), a 5-minute cooldown, then one probe start on the next
     demand, with the cooldown doubling per failed probe up to 30 minutes.
     The existing "a successful start clears the failure window" is kept.
   - Why: (a) turns a transient fault (a full disk, a `codex` upgrade the user
     then fixes) into a workspace that needs a bridge restart nobody knows to
     do. (b) does not answer the question: an open breaker never starts a
     generation, so there is nothing to stay healthy. A probe that runs only on
     real demand cannot become a background restart loop.
   - Pros: self-healing; bounded cost (at most one spawn per cooldown, two an
     hour at the cap); no timers while nobody asks. Cons: a permanently broken
     install now costs a probe spawn every 30 minutes of demand instead of
     none; a user may wait up to the cooldown after fixing the cause (a bridge
     restart still clears it at once).
2. **Terminal WebSocket ladder: when does it reset?**
   - Options: (a) keep resetting on `ready`, as before; (b) reset only after
     the socket stayed ready for 30 s, like every gateway stream.
   - Choice: (b), via `ReconnectBackoff`. The defaults stay 500 ms to 10 s,
     faster than the event streams because a terminal is interactive.
   - Why: the constraint "only a connection that stayed healthy resets the
     ladder"; a server that accepts and then drops the socket must back off.
   - Pros: one policy everywhere; no lock-step after a restart. Cons: a
     socket that flaps every few seconds now waits up to 10 s between
     attempts, where it used to retry at 500 ms (the HTTP fallback carries
     the terminal meanwhile).
3. **Jitter source for the terminal socket.**
   - Options: a new `terminalWebSocketReconnectRandom` option, or reuse the
     gateway's `eventReconnectRandom`/`eventReconnectNow`.
   - Choice: reuse. Pros: one seam for tests and embedders; matches the
     gateway's fallback streams using the main stream's options. Cons: a test
     cannot give the socket a different source than the event streams.
4. **Where the disconnect signal comes from.**
   - Options: (a) only the browser gateway's main stream; (b) also a new
     Electron IPC event from `BackendHttpClient.onStreamState`; (c) also the
     existing Electron connection list (`transport`, `localAvailable`).
   - Choice: (a) plus (c), combined in `transport-connectivity.ts` (down while
     any owner says so).
   - Why: the connection list already publishes the active connection's
     transport state to the renderer, so no desktop change is needed; Local
     is a child process whose loss is already `localAvailable: false`.
   - Pros: no new IPC; one place decides. Cons: Electron Local is not paused
     for a stream hiccup that does not end the process (none is expected on
     loopback); `connecting` and `authentication-required` deliberately do not
     pause, so an auth failure stays visible as read errors.
5. **Where freshness indicators live** (the open question).
   - Options: per view only; one connection banner only; one banner plus
     per-view detail.
   - Choice: one banner for transport outages, per-view indicators only for
     failures specific to that view.
   - Why: during an outage every view is behind for the same reason, and
     marking each would be noise; a view-specific failure (a failed PR read,
     an exhausted retry) is invisible to the banner.
   - Pros: one clear message per cause. Cons: per-view indicators do not light
     up during an outage by themselves until their own reads fail.
6. **Banner delay.** 4 s, so a blip that recovers on the first 2 s retry
   never shows. Pros: no flicker on restarts. Cons: a real outage is reported
   4 s late.
7. **Files panel and `unsupported`.** The Files panel polls every 5 s, so its
   revision feed only speeds updates up. It shows `stale`/`degraded` as
   delayed announcements and nothing for `unsupported`, which is the
   designed polling path. Pros: no false alarm on older backends. Cons:
   departs slightly from the item's wording ("unsupported for the Files
   view").
8. **Times shown.** Last successful check and last fetch are absolute local
   times, not "3m ago": a relative age needs a clock read in render (the
   React Compiler purity rule) and goes stale itself. Pros: never implies a
   new measurement. Cons: less glanceable.
9. **Coordinator legacy capability.** Keyed to the read coordinator's
   connection generation rather than reset by a separate connection listener.
   Pros: the same identity the read results are fenced by; no extra
   subscription. Cons: a reconnect to the same server keeps the remembered
   capability (correct unless that server was upgraded in place, which the
   next server switch or remount corrects).

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
  coverage and add rows for its own view. The coverage list now lives in
  `../../architecture/event-snapshot-recovery.md` ("Adopting the contract").

## Related

- [0052-remote-client-bandwidth.md](0052-remote-client-bandwidth.md): remote transport
  measurement, which shares the outage and slow-client workloads.
- [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md):
  observation invalidations and the read coordinator's native views.
- [0048-recurring-work-qualification.md](0048-recurring-work-qualification.md): the
  wider real-stack and two-client QA.
- `../../architecture/event-snapshot-recovery.md` (sequence semantics,
  supported peers, `remote` freshness, freshness in the UI) and
  `../../architecture/remote-gateway.md`. The living-doc drift this file
  listed is fixed: the step labels and plan pointers are gone from
  `event-snapshot-recovery.md`, its coverage list is inlined, and
  `remote-gateway.md` says that the 25 s keepalive also advances the cursor.

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
