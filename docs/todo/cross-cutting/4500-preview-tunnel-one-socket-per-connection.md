# Preview tunnel: one WebSocket per upstream connection

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`.

### Tasks

1. **Measure the cost**: how much page-load time and how many sockets the per-connection handshake costs on a remote route. Status: open.
2. **Decide on multiplexing, and build it if the numbers justify it**: Status: open (depends on 1).

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
  - **Decide after task 1, and only if handshakes show up in real page loads (recommended).**
    - Pros: does not take on a new protocol for a cost nobody has measured.
    - Cons: DK-6 stays open until then.
  - **Build multiplexing now.**
    - Pros: closes DK-6 as the report describes.
    - Cons: a new protocol with flow control and a compatibility path, for a Low-rated finding.
  - **Keep idle connections longer, by raising `poolIdleMs`.**
    - Pros: a one-line change that avoids reopening after short gaps.
    - Cons: holds upstream connections open at the application; does not help parallel requests.

## Constraints and rationale

Any change keeps what `preview-tunnel-client.ts` and `preview-transport-manager.ts` hold today: nothing is buffered before `OPEN_OK`, and a refused connection is retried only before application bytes were sent. The wider contract is [browser-previews.md](../../architecture/browser-previews.md).

## Related

- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md), task 12.
