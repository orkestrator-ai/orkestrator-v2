# Preview tunnel: one WebSocket per upstream connection

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`.

### Tasks

1. **Measure the cost**: how much page-load time and how many sockets the per-connection handshake costs on a remote route. Status: open (sockets counted by tests on 2026-11-04; remote page-load time still unmeasured, and it no longer gates task 2).
2. **Decide on multiplexing, and build it if the numbers justify it**: Status: done (2026-11-04, tunnel v2; see Assumptions and decisions).

### 1. Measure the cost

**Problem.** Finding DK-6 in [the 2026-10-27 efficiency report](../../reports/2026-10-27-efficiency.md) rates this Low with Medium confidence, and nothing has measured it.

**Context.** Split out of [1202](1202-efficiency-review-follow-ups.md) task 12, which re-checked it on 2026-11-04 and found it still applies. `desktop.connect_ms` (`preview-transport-manager.ts`) already records each tunnel's open time.

**Investigation.** Each new upstream connection pays TCP, TLS on an HTTPS route, the WebSocket upgrade, then HELLO and OPEN, which are pipelined and so cost one further round trip (read from code, not timed). The pool reuses an idle connection for 2 s and keeps up to six (`poolIdleMs`, `poolMax`), and `preview-transport-manager.test.ts` ("keep-alive upstream connections are pooled") covers it. So sequential requests share a socket, while parallel requests, WebSocket upgrades and a request after an idle gap each open one.

**Decisions.**

- **What to measure?**
  - **`desktop.connect_ms` and a socket count while loading one real page over a Tailscale route (recommended).**
    - Pros: this is where the round trips cost something; the metric exists.
    - Cons: needs a second machine.
  - **Loopback only.**
    - Pros: runs anywhere.
    - Cons: says little, since a loopback handshake is cheap.

### 2. Decide on multiplexing, and build it if the numbers justify it

**Problem.** The report's fix is to multiplex streams over one socket per attachment. That cannot be done inside the current protocol.

**Context.** One WebSocket is one upstream connection today: binary frames carry no stream id, and backpressure works by pausing the socket (`PreviewTunnelStream`), which is also why it pings while a consumer is not reading.

**Investigation.** Multiplexing needs stream ids in binary frames, per-stream OPEN, EOF, cancel and error, and per-stream credit, because otherwise one paused video would stall every other stream on the socket. A desktop can also connect to an older backend, so it needs negotiation and the current path as a fallback (`version-compatibility.md`). `preview-tunnel-server.ts` and `preview-tunnel-client.ts` both change.

**Decisions.**

- **Multiplex?**
  - **Decide after task 1, and only if handshakes show up in real page loads (recommended at analysis; superseded, see Assumptions and decisions).**
    - Pros: does not take on a new protocol for a cost nobody has measured.
    - Cons: DK-6 stays open until then.
  - **Build multiplexing now (chosen).**
    - Pros: closes DK-6 as the report describes.
    - Cons: a new protocol with flow control and a compatibility path, for a Low-rated finding.
  - **Keep idle connections longer, by raising `poolIdleMs`.**
    - Pros: a one-line change that avoids reopening after short gaps.
    - Cons: holds upstream connections open at the application; does not help parallel requests.

## Current state

Done 2026-11-04 on branch `desktop-window-transport-e6e965c2f004-r1` for [1202](1202-efficiency-review-follow-ups.md) task 12, whose criterion needed DK-6 fixed or shown not to apply.

- **Protocol.** `packages/protocol/src/preview-tunnel-mux.ts`: subprotocol `orkestrator.preview-tunnel.v2`. HELLO once per WebSocket; then `OPEN {stream}` per upstream connection with strictly increasing ids; binary messages carry a 4-byte stream id; `EOF`, `CANCEL`, `CLOSED`, `CREDIT` and stream-scoped `ERROR` name their stream. At most 32 open streams per session and 256 KiB uncredited per stream and direction. Malformed frames, reused ids, data past credit, and more than 32 streams close with 4400.
- **Negotiation.** Attachments' tunnel descriptors carry `multiplexSubprotocol` (`apps/backend/src/core/preview-access.ts`). The desktop offers v2 then v1 only when it is there; a server that still answers v1 gets v1. `connectPreviewWebSocket` now accepts several offered subprotocols and exposes the chosen one (`PreviewWebSocket.protocol`).
- **Backend.** `preview-tunnel-mux-server.ts`, called from `PreviewTunnelServer.handleUpgrade` when v2 is offered. Each stream takes one slot of the existing tunnel admission (so the per-service and per-backend tunnel limits still count upstream connections); each session takes one slot of a separate session admission with the same limits. Revocation, lease expiry and shutdown close the WebSocket and every stream. A stream out of credit, or blocked by the socket's 256 KiB queue or the 64 MiB aggregate, pauses its own upstream; the socket itself is never paused, so liveness pings are always read. v1 is served unchanged and counted as `preview.tunnel-v1`.
- **Desktop.** `PreviewTunnelConnector` (`apps/desktop/electron/preview-tunnel-session.ts`), one per service group in `PreviewTransportManager`. Concurrent opens join one connecting session; the session does not use any one request's abort signal. A new attachment retires the previous sessions (no new streams, close once empty); an idle session closes after 30 s; group disposal terminates them. An `OPEN` refused with `access-expired` or `generation-changed` retires the session, and the manager's existing retry and reattach rules apply unchanged.
- **Tests.** `apps/backend/src/preview-tunnel-mux-server.test.ts`, `apps/desktop/tests/preview-tunnel-session.test.ts`, two new cases in `apps/desktop/tests/preview-transport-manager.test.ts`. The four manager cases that race two tunnel handshakes now run against a simulated older backend (attachments without `multiplexSubprotocol`), since on v2 the second request joins the first's session. `e2e/agent-testing/service-preview-electron.spec.ts` ran over v2 in real Electron windows.

## Assumptions and decisions

### Task 2: build multiplexing without the measurement first

1202 task 12's acceptance criterion requires DK-6 fixed with a test or shown not to apply, and it applies, so task 2 could not wait for task 1. Task 1 is left open: it would show how much page-load time v2 saves over a remote route, not whether to build it.

### Task 2: negotiation by advertisement, not by handshake fallback alone

Options: (a) the desktop offers v2 and v1 on every connect and learns from the answer; (b) the backend advertises v2 in the attachment, and the desktop offers v2 only then. Chose (b), keeping (a)'s fallback for a server that answers v1 anyway. With (a) alone, the first burst against an older backend would wait on one handshake before the rest could open their own v1 sockets; with (b) an older backend sees exactly what it saw before.

### Task 2: flow control per stream by credit

Options: pause the shared socket as v1 does, or per-stream credit. Pausing the socket would stall every stream behind one stopped reader (paused media), so chose credit: each direction may have 256 KiB in flight per stream (the existing per-direction queue bound), and credit returns in quarter-window batches once the consumer has taken the bytes, which keeps control frames off small requests. The backend credits uploads when the upstream write completes, the desktop when its reader has taken the data.

### Task 2: admission counts upstream connections, not sockets

Each stream keeps its own slot of the existing tunnel admission, so `tunnelsPerService` and `tunnelsPerBackend` still bound upstream connections exactly as on v1. Sessions get a separate admission with the same limits, so authenticated sockets with no streams stay bounded too. A stream refused for capacity fails alone (`OPEN_FAILED`); v1 closed the whole socket with 4429.

### Task 2: session lifetime

Sessions are per attachment, because HELLO authenticates one attachment and revoking it must close everything. A new attachment retires older sessions rather than closing them, so connections already open run to completion as they did on v1. An idle session closes after 30 s (the backend's liveness interval); the pool's 2 s idle still applies to the upstream connections themselves.

## Constraints and rationale

Any change keeps what `preview-tunnel-client.ts` and `preview-transport-manager.ts` hold today: nothing is buffered before `OPEN_OK`, and a refused connection is retried only before application bytes were sent. The wider contract is [browser-previews.md](../../architecture/browser-previews.md).

## Needs verification

- Page-load time over a remote (Tailscale) route on v1 and v2 (task 1). `desktop.connect_ms` now records each stream's time to `OPEN_OK`, including the session connect for the first one.

## Related

- [Version-compatibility register](../../architecture/version-compatibility.md#register): the v1 path and its retirement condition.

- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md), task 12.
