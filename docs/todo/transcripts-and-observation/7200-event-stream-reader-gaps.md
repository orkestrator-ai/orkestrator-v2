# Event-stream reader gaps

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`, from the reader inventory
of [0048](0048-recurring-work-qualification.md) task 20 (see its
[Event-stream reader inventory](0048-recurring-work-qualification.md#event-stream-reader-inventory-2026-11-06)).
Tasks 1 and 4 done 2026-11-10 against `main` at `04639b12b`.

### Tasks

1. **OpenCode event monitor silence**: the backend's OpenCode event stream has no silence watchdog, so a connection that stays open but goes quiet is never replaced. Status: done (2026-11-10: `opencode serve` 1.19.5 observed sending `server.heartbeat` every 10 s; a 35 s watchdog armed by the first heartbeat replaces a silent stream).
2. **Desktop connection retries in lock-step**: the desktop connection manager's reconnect ladder has no jitter. Status: done (2026-11-06: each delay drawn from the upper half of its rung).
3. **Preview tunnel with no pong deadline**: the desktop preview tunnel pings but never acts on a missing pong. Status: done for the v2 session (2026-11-06: two unanswered pings destroy it); v1 deliberately left (see decision T3).
4. **Terminal WebSocket stall while the page stays visible**: nothing pings the terminal socket on a timer, so a socket that stalls while the page is visible is noticed only by a 30 s operation timeout or the main stream's watchdog. Status: done (2026-11-10: a ping after each quiet 10 s while the page is visible; two unanswered pings replace the socket).

### 1. OpenCode event monitor silence

**Problem.** `OpenCodeProvider.monitorRequests` (`apps/backend/src/core/opencode-provider.ts:440`) reads the OpenCode SDK's event stream until it ends or throws, and reconnects with a jittered 1 s to 30 s backoff. Nothing notices a stream that stays open and goes silent. OpenCode's activity is built from these events (`activitySnapshot: "sdk-event-fed-batch"`, `native-agent-observation.ts`), so a hung OpenCode process or a stalled connection would freeze its activity and its pending requests until the TCP connection breaks.

**Context.** Every other backend stream reader has a watchdog: the bridge observation stream (`BRIDGE_OBSERVATION_STREAM_SILENCE_MS`, 75 s, against bridge keepalives every 30 s) and the federation event stream (`NODE_EVENT_STREAM_IDLE_MS`, 75 s). A watchdog needs the server to send something while idle. The pinned SDK's generated types declare no heartbeat event (only `server.connected`), so whether `opencode serve` sends one is unknown. The connection is host-local or to a container's mapped port, so a half-open connection is unlikely but possible across a container pause.

**Investigation.** `OpenCodeObservationStream` (`opencode-observation-stream.ts`) is live from the first frame until a loss and has no timer. The SDK call passes `sseMaxRetryAttempts: 1` (`opencode-provider.ts:449`), so the outer loop owns reconnects. No test covers a silent OpenCode stream. Not fixed in 0048's run: what the server sends on an idle `/event` stream can only be observed against a live `opencode serve`, and that run used no provider.

**Decisions.**

- **How to detect silence?**
  - **First check what `opencode serve` sends on an idle `/event` stream; if it sends a periodic frame, add a watchdog like the bridge observation stream's (recommended, done).**
    - Pros: the same pattern and bounds as the other readers; no extra requests.
    - Cons: needs a live OpenCode server to observe, and depends on OpenCode keeping that frame.
  - **Probe with a cheap SDK request every N seconds and abort the stream when it fails.**
    - Pros: works whatever the server sends.
    - Cons: a recurring request per OpenCode environment, which recurring work must then account for.

### 2. Desktop connection retries in lock-step

**Problem.** `ReconnectScheduler.schedule` (`apps/desktop/electron/connection-scheduling.ts:39`) waited exactly `DEFAULT_RECONNECT_DELAYS_MS` (1, 2, 5, 10, 30, 60 s, `connection-manager.ts:129`). Desktops that lost the same remote backend at the same moment retried it at the same moments.

**Context.** Retired 0051 added jittered backoff (`ReconnectBackoff`, `packages/protocol/src/reconnect-backoff.ts`) to the event-stream client below this manager, so the stream itself already spreads. Few desktops share one remote backend, so the herd is small.

**Investigation.** The manager's retries are route and handover attempts per machine (`recordFailure`, `watchTransport`), not stream reads. `MAX_BACKGROUND_ATTEMPTS` (4) bounds how many run at once per desktop, not when. The only caller of `schedule` is the retryable-failure path (`connection-manager.ts:1658`).

**Decisions.**

- **Spread them?**
  - **Draw each delay from the upper half of its rung with `reconnectDelayMs` (recommended, done).**
    - Pros: one shared helper and the same spread as the stream client; tests can inject the random source.
    - Cons: a retry can come up to half a rung sooner than the ladder says.
  - **Leave it.**
    - Pros: no change for a small herd.
    - Cons: a restarted shared backend still gets synchronized attempts.

### 3. Preview tunnel with no pong deadline

**Problem.** The desktop preview tunnel client and session (`preview-tunnel-client.ts:66`, `preview-tunnel-session.ts:224`) pinged every `PREVIEW_TUNNEL_CLIENT_PING_MS` (15 s), but no code listened for the pong. A half-open session stayed open and selectable.

**Context.** The server side closes a tunnel it has not heard from (`apps/backend/src/preview-tunnel-mux-server.ts:144`, `preview-tunnel-server.ts:236`), so only the client was blind. Only browser previews of a remote environment use the tunnel; an idle v2 session already closes after 30 s.

**Investigation.** A stream-open timeout retires only that stream, not the session: `openStream`'s timer calls `abandon`, which sends `cancel` and `becameIdle()` but never `fail`, `retire` or `close`, and `canOpen` depends only on authentication, retirement, `ws.isOpen` and capacity. So while other streams kept a dead session from going idle, every new preview stream on it waited the full `2 × connectTimeoutMs` (20 s) and failed. `PreviewWebSocket` already emitted `pong`; nothing listened.

**Decisions.**

- **How to retire a dead session?**
  - **A pong deadline (two missed pings) that destroys the session, so the next preview opens a new one (recommended, done).**
    - Pros: matches the server's own rule; bounded detection at about 30 s.
    - Cons: a session with no frames and no pongs for 30 s is closed even if the peer would have recovered.
  - **Retire the session when a stream open times out.**
    - Pros: no timer while idle.
    - Cons: the first preview after a drop still waits out a full open timeout.

### 4. Terminal WebSocket stall while the page stays visible

**Problem.** `TerminalWebSocketClient` (`apps/web/src/lib/native/terminal-websocket-client.ts`) asks the server for a pong only when the page becomes visible again (`probeLiveness`, 2.5 s). While the page stays visible, a terminal socket that stalls on its own is noticed only by a pending operation's 30 s timeout (`DEFAULT_OPERATION_TIMEOUT_MS`) or when the main event stream's watchdog drops every connection.

**Context.** The client's own comment says the main event stream "may keep heartbeating while this one silently stalls". The server answers `ping` (`apps/backend/src/terminal-websocket-server.ts`). Terminal output and keystroke acknowledgements usually reveal a stall within seconds, so this matters mostly for an idle terminal that the user returns to without leaving the page.

**Investigation.** Found by the 0048 task 20 inventory; not exercised live. Reconnects already use a jittered backoff (500 ms to 10 s, `reconnectDelayMs`).

**Decisions.**

- **Detect it?**
  - **A periodic ping while channels are desired and the page is visible, replacing the socket when two go unanswered (recommended, done).**
    - Pros: the same probe the visibility path already uses; bounded detection.
    - Cons: one small frame per interval per open terminal page.
  - **Leave it to operation timeouts and the main stream.**
    - Pros: no traffic.
    - Cons: an idle terminal can sit on a dead socket until the user types.

## Assumptions and decisions

### T1a. What `opencode serve` sends while idle (task 1)

Observed 2026-11-10 on beelink2: the pinned `opencode` 1.19.5 from the managed
toolchain, run as `opencode serve` on a loopback port with a throwaway
`HOME` and XDG directories, no credentials and no session. `GET /event` sent
`server.connected` and then one `server.heartbeat` data frame every 10 s for
70 s, nothing else. The pinned SDK's `Event` union does not declare the
heartbeat, so until this change every one of them was counted as an
unknown-event drift kind by `handleRequest`.

### T1b. A deadline armed by the first heartbeat (task 1)

`OpenCodeStreamSilenceWatchdog` (`opencode-observation-stream.ts`) aborts the
connection's stream controller after `OPENCODE_EVENT_STREAM_SILENCE_MS`
(35 s: three missed heartbeats plus slack) with no frame; the monitor then
takes its normal loss path (gap, snapshot reconcile, jittered reconnect) and
logs `monitor.silent`. It is armed only once the connection has sent a
heartbeat: an OpenCode that predates the frame (a PATH install outside the
managed toolchain) is legitimately silent while idle, and an unconditional
deadline would reconnect it every 35 s forever. The cost is that a stream
that stalls before its first heartbeat (within 10 s of connecting) is not
caught; that stays as it was before this change. Heartbeats are consumed in
the read loop as liveness and never dispatched, so they no longer count as
drift. The timer re-checks elapsed silence instead of restarting per frame,
and the loop's `finally` stops it. The 2.x provider
(`opencode2/provider.ts`) reads a different stream (`/api/event`, whose
heartbeat is an SSE comment its parser drops) and is not covered:
[7551](7551-opencode2-event-stream-silence.md). Tests:
`apps/backend/src/core/opencode-provider-silence.test.ts`.

### T4. Ping only a quiet socket, every 10 s (task 4)

The heartbeat runs while channels are desired, the page is visible, and the
current socket is ready and advertised the `ping` feature; any other state
stops it, and `dispose`, a close, a replacement, `dropConnection` and the last
unsubscribe all cancel it. Every inbound frame counts as an answer, so a busy
terminal sends no pings at all; a socket heard from nothing for an interval
(`DEFAULT_TERMINAL_HEARTBEAT_INTERVAL_MS`, 10 s) is pinged, and one that
leaves two pings unanswered is replaced exactly as the foreground probe does
(`replaceSocketForForeground`: channels reconcile, the reconnect ladder is
kept). A stall is noticed 20 to 30 s after the socket's last frame, before
the 30 s operation timeout. A 10 s interval was chosen over 15 s (30 to 45 s,
no better than the operation timeout) and 5 s (twice the traffic for an idle
page). A hidden page sends nothing, so background terminal work is not cut;
returning to the page runs the existing 2.5 s probe and restarts the
heartbeat. Tests: the heartbeat block in
`apps/web/src/lib/native/terminal-websocket-client.visibility.test.ts`.

### T2. Jitter only shortens a rung (task 2)

The ladder's values stay the documented maximums
(`docs/architecture/federation.md`), and each delay is drawn from
`[rung / 2, rung]` with `reconnectDelayMs`'s default equal jitter. A wider or
upward spread was not used, so no retry is ever later than the ladder says.
Test: `apps/desktop/tests/connection-scheduling.test.ts`.

### T3. Only the v2 session gets the deadline (task 3)

`PreviewTunnelSession` never pauses its socket (each stream has its own credit
window), so every pong is read as it arrives, and any inbound frame also counts
as an answer. The v1 `PreviewTunnelStream` pauses its socket when the consumer
stops reading (`ws.pause()` on a full buffer), and then its pongs wait behind
unread data: a deadline there would close a healthy paused stream, which is
exactly what its ping exists to prevent. v1 carries one connection per socket
and only serves backends without v2, so a dead v1 socket costs one stream.
The session is destroyed (`terminate`), not closed, because a dead peer never
answers the close frame; the close event then removes it from the connector.
Tests: the two heartbeat cases in `apps/desktop/tests/preview-tunnel-session.test.ts`.

## Related

- [7551](7551-opencode2-event-stream-silence.md): the OpenCode 2.x provider's event stream, found while doing task 1.

- [0048](0048-recurring-work-qualification.md) task 20: the inventory and every reader's disposition.
- [0049](0049-native-agent-idle-observation.md): OpenCode's live observation runs.
