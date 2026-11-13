# Bearer terminal stream: live evidence

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`, plus the shared terminal stream built for efficiency report 0120 (GW-3). Task 1 run 2026-11-13 against `main` at `17d28238c`.

### Tasks

1. **A bearer client in a real browser**: see one terminal stream carry several terminals from a real bearer or cross-origin client, with `/invoke` still answering promptly. From report 0120, task 1 ("Share one filtered stream on the fetch path"), whose code is done. Status: done (2026-11-13, see Assumptions and decisions).

### 1. A bearer client in a real browser

**Problem.** Bearer and cross-origin web clients used to open one long-lived fetch per terminal. On HTTP/1.1 a browser allows about six connections per host, so five terminals left little for `/invoke`, and with compression `on` each stream also held one of the gateway's eight streaming-gzip slots (`MAX_CONCURRENT_STREAMING_COMPRESSIONS`, `apps/backend/src/gateway-support-core.ts`). The fix is proven only with fakes.

**Context.** Since 2026-11-05 every web client carries all its terminals on one filtered stream (`includeEvents=a,b,c`). `refreshSharedTerminalConnection` in `apps/web/src/lib/native/web-gateway.ts` owns it, and `openSharedTerminalConnection` reads it with an `EventSource` when no bearer token has to be sent and with `fetch` otherwise. Changing the filter reopens the stream and tells each terminal it already carried to re-read its snapshot. The comma-separated filter has been accepted since July 2026, before the support window's floor (v2.21.0), so no compatibility path was needed.

**Investigation.** `web-gateway-shared-terminal-stream.test.ts` shows a bearer client opening one authenticated fetch for two terminals, rebuilding it once for a third with a desync to the first two only, leaving it alone when a terminal re-listens to the same event, and a cross-origin client with seven terminals holding one request. The reconnect, silent-link and WebSocket-fallback suites run the same paths for direct clients. No real browser was pointed at a gateway with a bearer token: the agent-test profiles sign the browser in with a cookie session, which takes the same-origin `EventSource` path, not this one.

**Live run (2026-11-13).** `e2e/agent-testing/bearer-terminal-stream-live.spec.ts` loads the web client's own gateway module into a blank page in headless Chromium (Playwright 1.65.0), gives it the profile's gateway token, so it takes the bearer `fetch` path, and points it through a loopback link (`client-outage-support.ts`) that records every request's kind, open and close times. Plain HTTP on loopback is HTTP/1.1, so Chromium's six connections per host apply. Seven terminals of one local environment each printed a line every 50 ms for 20 s:

| Measured | Result |
| --- | --- |
| Terminal streams open at once while all seven printed (9 s window), link and browser network log | 1 and 1 (one stream opened in all) |
| Main event streams open | 1 |
| Terminals whose output arrived on that stream | 7 of 7 (at least 6,219 bytes and 350 chunks each, no desync) |
| `/invoke` before output, 10 sequential | p50 17 ms, p90 25 ms, max 61 ms |
| `/invoke` while printing, 30 sequential | p50 9 ms, p90 25 ms, max 45 ms |
| `/invoke` while printing, 8 bursts of 5 in parallel | p50 14 ms, p90 35 ms, max 40 ms |
| An eighth terminal joining | the stream was rebuilt once; for about a second both were open (the new one opens before the old closes), then one; all 7 earlier terminals were told to re-read their snapshot |
| Control: six bearer streams opened by hand, one per terminal as before GW-3, on a second link | all six answered 200, and an `/invoke` behind them got no answer in 4,001 ms |

The control shows the browser's limit is real on this origin: per-terminal streams would have held every `/invoke` back. The run took 32 s:

```bash
ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile b5340qa --fixture --headless \
  --no-agent-credentials --no-host-seed --agent-platforms claude
ORKESTRATOR_HOST_REACHABILITY_CHECK=off ORKESTRATOR_AGENT_TEST_PROFILE=b5340qa \
  ORKESTRATOR_AGENT_TEST_RUN_ID=b5340qa ORKESTRATOR_AGENT_TEST_LIVE_BEARER_TERMINALS=1 \
  mise run test:logged -- --name bearer-terminals -- bunx playwright test \
  --config e2e/agent-testing/playwright.browser.config.ts bearer-terminal-stream-live.spec.ts --workers=1
```

The first run found that the blank page could no longer import `web-gateway.ts`: its imports now reach a `.tsx` module, and `@vitejs/plugin-react` refuses one without the refresh preamble the app's `index.html` installs. `installReactRefreshPreamble` (`client-outage-support.ts`) installs it, and `client-outage.spec.ts`'s direct clients, which load the module the same way, call it too.

**Decisions.**

- **How to qualify it?**
  - **One real-browser pass with a direct connection on an isolated `dev:test` profile: open five or more terminals, count the open terminal requests in the browser's network log, and time an `/invoke` while they stream (recommended).**
    - Pros: the path a hosted or workspace-realm client takes, with a real browser's connection limit.
    - Cons: needs a direct-connection setup the agent-testing harness does not provide yet.
  - **A Playwright spec that loads the web client with `baseUrl` and a token injected into the page.**
    - Pros: repeatable once written.
    - Cons: injecting the token bypasses the real connection flow, and the spec must keep the token out of traces and artifacts.

## Current state

Every web client shares one terminal stream; the bearer and cross-origin paths read it with `fetch`. Unit tests cover the behaviour, and a real headless browser showed it on 2026-11-13 (above). No agent work is left, so this file is retired. Which real routes (Tailscale Serve, hosted) still negotiate HTTP/1.1 is on the manual-test checklist (7568: 5380 task 2); the fix does not depend on the answer.

## Assumptions and decisions

### Task 1: the real gateway module in a page, rather than the full app or a new direct-connection harness

Chose the decision's second option in the form `client-outage.spec.ts` already uses: the web client's own `createBrowserGatewayApi` in a blank page, given the token as a page argument, with traces, screenshots and video off so the token stays out of artifacts. This is the code a hosted or workspace-realm client runs, in a real browser with its real connection limit; the agent-test sign-in only produces cookie clients, which take the `EventSource` path. The full app shell was not loaded because a cookie session would take over, and building a hosted-client connection flow for a profile is more than the evidence needs. The link proxy gained a `closedAt` per request so it can count streams open at the same moment.

### Task 1: a bearer client on its own origin, not a cross-origin one

The page and the gateway it talks to share the link's origin. A cross-origin page needs the gateway's allowed-origins list, which a `dev:test` profile does not set; the transport takes the same `fetch` branch for both (a bearer token or a base URL selects it, in `apps/web/src/lib/native/node-transport.ts`), and the connection limit is per host either way. A real hosted client's route is the manual-test checklist's item for task 2.

### Task 1: a control with six hand-opened streams

Added so the result cannot pass on a browser that would not have starved anyway: on a second link, six per-terminal bearer streams hold an `/invoke` for the whole 4 s wait.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 2, `nextHopProtocol` from a real Tailscale Serve client and a hosted client) moved there on 2026-11-10.
- to-do 1202 efficiency follow-ups, task 4 (retired 2026-11-10) (GW-3)
- 0052 remote client bandwidth (retired 2026-11-11; [remote-bandwidth.md](../../development/remote-bandwidth.md))
- Efficiency report, A (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`), GW-3
- [Remote gateway, event stream reconnects](../../architecture/remote-gateway.md#event-stream-reconnects)
