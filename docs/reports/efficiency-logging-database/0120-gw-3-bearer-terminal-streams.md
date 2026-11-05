# Bearer-token web clients open one event stream per terminal

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Share one filtered stream on the fetch path**: reuse the same-origin client's shared-stream logic for bearer and cross-origin clients. Status: open.

### 1. Share one filtered stream on the fetch path

**Problem.** A bearer or cross-origin client holds one long-lived request per terminal. On HTTP/1.1 a browser allows six connections per host, so five terminals leave little for `/invoke`. In `on` compression mode each stream also takes one of the eight streaming-gzip slots, and a client over the limit falls back to identity.

**Context.** Same-origin browsers already share one filtered `EventSource`, which was added because WKWebView runs out of long-lived requests. Compression became `on` by default after the report, which makes the gzip slots matter to more clients.

**Investigation.** `apps/web/src/lib/native/web-gateway.ts:1092-1098` opens `fetch(apiUrl(eventStreamPath(stream.event)))` per terminal, and the type comment at `:241-242` says so. The shared path is `refreshBrowserTerminalEventSource` (`:970`), and its reasoning is at `:946-960`. `eventStreamPath` (`:498`) already accepts a list of events. A reopened stream announces a scoped desync so each terminal reconciles (`announceTerminalStreamOpen`, `:917`). The slot limit is `MAX_CONCURRENT_STREAMING_COMPRESSIONS` (`apps/backend/src/gateway-support-core.ts:270`).

**Decisions.**

- **How to build the shared fetch stream?**
  - **Generalise the shared-stream state so one owner drives either an `EventSource` or a fetch reader (recommended).**
    - Pros: the filter, the no-op on an unchanged filter and the desync-on-reopen rules stay in one place.
    - Cons: touches the same-origin path too, so its tests must still pass unchanged.
  - **Write a second shared stream for the fetch path.**
    - Pros: no risk to the same-origin path.
    - Cons: two copies of subtle rules, which is what theme T4 of the report warns about.

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): missed events must stay detectable. Changing the filter reconnects the stream, so every terminal already connected needs the scoped desync notice.
- Unrelated to the baseline gate on the rest of 1202 task 4: this is a local client change, not a new protocol.

## Open questions

- 1202 groups this with the baselined live-view work (task 4). The fix does not depend on those measurements, so it could ship first. That ordering has not been decided.

## Needs verification

- Which real clients still use HTTP/1.1 for this path. Tailscale Serve and hosted routes may negotiate HTTP/2, which removes the six-connection limit but not the gzip slot use. Not observed.

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-3)
- [1202 task 4](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0052 remote client bandwidth](../../todo/transcripts-and-observation/0052-remote-client-bandwidth.md)

## Outcome

Re-checked on 2026-11-05 against `main` at `69a3b4ca5`: the finding still held. The per-terminal fetch had moved to `web-gateway.ts:1114`, and the local desktop window had since been given its own opt-in to the shared stream (`sharedTerminalStream`), but bearer and cross-origin clients still opened one request per terminal.

| Item in this file | Outcome |
| --- | --- |
| Task 1: share one filtered stream on the fetch path | Done, with the recommended option. One owner (`refreshSharedTerminalConnection` in `apps/web/src/lib/native/web-gateway.ts`) drives either an `EventSource` or a fetch reader (`openSharedTerminalConnection`), chosen by `sharedTerminalStreamUsesEventSource`: an `EventSource` only when no bearer token has to be sent, as before for same-origin pages and the local desktop window (`terminalEventSource`, renamed from `sharedTerminalStream`). The per-terminal fetch, its ladders and its state are gone. Tests: `web-gateway-shared-terminal-stream.test.ts` (one authenticated stream for several terminals, a rebuild with a scoped desync for terminals already carried, no rebuild on an unchanged filter, one credential-free stream for seven cross-origin terminals, the transport choice); the direct-client cases in `web-gateway.test.ts`, `web-gateway-reconnect.test.ts` and `web-gateway-silent-recovery.test.ts` now assert the shared stream. Same-origin tests pass unchanged. |
| Task 1, live evidence in a real browser | Moved to to-do [5380](../../todo/transcripts-and-observation/5380-bearer-terminal-stream-live-evidence.md), task 1. |
| Constraints: missed events stay detectable | Done: a filter change or reopen announces the scoped desync to every terminal the stream already carried (`announceTerminalStreamOpen`), tested as above. The comma-separated `includeEvents` filter predates the support window's floor, so no compatibility path was needed. |
| Open question: ship before 1202 task 4's measurements? | No longer holds: it shipped on its own, as the question allowed; 1202 task 4 records GW-3 as done. |
| Needs verification: which real clients use HTTP/1.1 | Moved to to-do [5380](../../todo/transcripts-and-observation/5380-bearer-terminal-stream-live-evidence.md), task 2. The fix does not depend on the answer. |
