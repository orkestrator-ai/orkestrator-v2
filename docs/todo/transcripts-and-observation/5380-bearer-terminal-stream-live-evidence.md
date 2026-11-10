# Bearer terminal stream: live evidence

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`, plus the shared terminal stream built for efficiency report 0120 (GW-3).

### Tasks

1. **A bearer client in a real browser**: see one terminal stream carry several terminals from a real bearer or cross-origin client, with `/invoke` still answering promptly. From report 0120, task 1 ("Share one filtered stream on the fetch path"), whose code is done. Status: open.

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

## Current state

Every web client shares one terminal stream; the bearer and cross-origin paths read it with `fetch`. Unit tests cover the behaviour; real-browser evidence is open here. Which real routes (Tailscale Serve, hosted) still negotiate HTTP/1.1 is on the manual-test checklist (7568: 5380 task 2); the fix does not depend on the answer.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 2, `nextHopProtocol` from a real Tailscale Serve client and a hosted client) moved there on 2026-11-10.
- to-do 1202 efficiency follow-ups, task 4 (retired 2026-11-10) (GW-3)
- [0052 remote client bandwidth](0052-remote-client-bandwidth.md)
- Efficiency report, A (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`), GW-3
- [Remote gateway, event stream reconnects](../../architecture/remote-gateway.md#event-stream-reconnects)
