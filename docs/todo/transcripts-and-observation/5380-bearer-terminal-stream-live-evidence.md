# Bearer terminal stream: live evidence

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`, plus the shared terminal stream built for efficiency report 0120 (GW-3).

### Tasks

1. **A bearer client in a real browser**: see one terminal stream carry several terminals from a real bearer or cross-origin client, with `/invoke` still answering promptly. From report 0120, task 1 ("Share one filtered stream on the fetch path"), whose code is done. Status: open.
2. **Which real routes still use HTTP/1.1**: find out which real clients reach the gateway over HTTP/1.1 on this path. From report 0120, "Needs verification". Status: open.

### 1. A bearer client in a real browser

**Problem.** Bearer and cross-origin web clients used to open one long-lived fetch per terminal. On HTTP/1.1 a browser allows about six connections per host, so five terminals left little for `/invoke`, and with compression `on` each stream also held one of the gateway's eight streaming-gzip slots (`MAX_CONCURRENT_STREAMING_COMPRESSIONS`, `apps/backend/src/gateway-support-core.ts`). The fix is proven only with fakes.

**Context.** Since 2026-11-05 every web client carries all its terminals on one filtered stream (`includeEvents=a,b,c`). `refreshSharedTerminalConnection` in `apps/web/src/lib/native/web-gateway.ts` owns it, and `openSharedTerminalConnection` reads it with an `EventSource` when no bearer token has to be sent and with `fetch` otherwise. Changing the filter reopens the stream and tells each terminal it already carried to re-read its snapshot. The comma-separated filter has been accepted since July 2026, before the support window's floor (v2.21.0), so no compatibility path was needed.

**Investigation.** `web-gateway-shared-terminal-stream.test.ts` shows a bearer client opening one authenticated fetch for two terminals, rebuilding it once for a third with a desync to the first two only, leaving it alone when a terminal re-listens to the same event, and a cross-origin client with seven terminals holding one request. The reconnect, silent-link and WebSocket-fallback suites run the same paths for direct clients. No real browser was pointed at a gateway with a bearer token: the agent-test profiles sign the browser in with a cookie session, which takes the same-origin `EventSource` path, not this one.

**Decisions.**

- **How to qualify it?**
  - **One real-browser pass with a direct connection on an isolated `dev:test` profile: open five or more terminals, count the open terminal requests in the browser's network log, and time an `/invoke` while they stream (recommended).**
    - Pros: the path a hosted or workspace-realm client takes, with a real browser's connection limit.
    - Cons: needs a direct-connection setup the agent-testing harness does not provide yet.
  - **A Playwright spec that loads the web client with `baseUrl` and a token injected into the page.**
    - Pros: repeatable once written.
    - Cons: injecting the token bypasses the real connection flow, and the spec must keep the token out of traces and artifacts.

### 2. Which real routes still use HTTP/1.1

**Problem.** Report 0120 noted that Tailscale Serve and hosted routes may negotiate HTTP/2, which removes the six-connection limit but not the gzip slot use. It was never observed which real clients use HTTP/1.1.

**Context.** The fix does not depend on the answer: one stream per client helps on both protocols, on HTTP/2 by freeing gzip slots. The answer matters for 0052's remote-route measurements and for judging how often the old behaviour hurt.

**Investigation.** Boot metrics already report `nextHopProtocol` for the page's navigation (`sendBootMetrics` in `web-gateway.ts`, `/client-metrics`), which names the protocol a client used. No real route's metrics were read for this report.

**Decisions.**

- **How to find out?**
  - **Read `nextHopProtocol` from the boot metrics of a real Tailscale Serve client and a hosted client, alongside 0052's remote-route matrix (recommended).**
    - Pros: no code; the same run 0052 already owes.
    - Cons: waits on 0052's Tailscale run.
  - **Add the protocol to the gateway's own request metrics.**
    - Pros: every route reports it continuously.
    - Cons: a new metric for a question the fix no longer depends on.

## Current state

Every web client shares one terminal stream; the bearer and cross-origin paths read it with `fetch`. Unit tests cover the behaviour; real-browser evidence and the HTTP/1.1 question are open here.

## Related

- [1202 efficiency follow-ups](../cross-cutting/1202-efficiency-review-follow-ups.md), task 4 (GW-3)
- [0052 remote client bandwidth](0052-remote-client-bandwidth.md)
- Efficiency report, A (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`), GW-3
- [Remote gateway, event stream reconnects](../../architecture/remote-gateway.md#event-stream-reconnects)
