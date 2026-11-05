# Terminal WebSocket: live evidence left from efficiency report 0100

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`.

What was left of `docs/reports/efficiency-logging-database/0100-e19-terminal-websocket.md` (batch E19) once its code was done. That report is deleted; read it with `git show e198fd4a7:docs/reports/efficiency-logging-database/0100-e19-terminal-websocket.md`. The work itself and its numbers are in [1202 task 11](1202-efficiency-review-follow-ups.md) and task 3.

### Tasks

1. **How many users have this transport on**: part `0610` (WEB-11), its Needs verification item. Status: open.
2. **The liveness probe on a real mobile WebView and a slow link**: part `0610` (WEB-11) task 1. Status: open.
3. **Input results past loopback Chromium**: part `0375` (GW-16) task 3. Status: open.

### 1. How many users have this transport on

**Problem.** Parts `0100`, `0375` and `0610` only reach users of the opt-in terminal WebSocket, and nobody knows how many that is. Local windows and default web clients use other paths.

**Context.** The transport is on only when `terminalTransport` or the `orkestrator-terminal-transport` localStorage key says so (`terminalTransportEnabled` in `apps/web/src/lib/native/web-gateway.ts`). Backends send nothing anywhere by design ([version-compatibility.md](../../architecture/version-compatibility.md#usage-counters)), so the answer can only come from machines someone can reach.

**Investigation.** Not run: no real install was read for this. Each backend's `/__orkestrator/metrics` already has `terminalWebSocket.opened`, and `compatibilityPaths` has `terminal-websocket.per-input-results` for sockets from older renderers.

**Decisions.**

- **How to find out?**
  - **Read `terminalWebSocket.opened` on the machines the maintainer can reach (recommended).**
    - Pros: uses counters that exist; sends nothing anywhere.
    - Cons: says nothing about other people's installs.
  - **Add usage telemetry.**
    - Pros: a true count.
    - Cons: the backend reports nothing outward today, and this question does not justify starting.

### 2. The liveness probe on a real mobile WebView and a slow link

**Problem.** Each return to the page used to close the socket and re-subscribe every channel. It now pings the socket and keeps it when the pong arrives within 2.5 s. That a socket left dead in the background really gets no pong and is replaced, and that 2.5 s is long enough for a healthy pong on a slow link, has not been seen on real hardware.

**Context.** The rebuild exists because mobile WebViews can keep an apparently open, dead socket while backgrounded. `onVisibilityChange` in `apps/web/src/lib/native/terminal-websocket-client.ts` decides. A kept channel still detects a gap through its revision and generation, and an unanswered probe replaces the socket as before. The 2.5 s figure is a judgment, not a measurement.

**Investigation.** The code and its tests are done: `terminal-websocket-client.visibility.test.ts` with fake sockets, and `apps/backend/tests/gateway-terminal-liveness.test.ts` for the real gateway's answer. Not run: a phone, a backgrounded WebView, or a throttled link. The same gap is listed in 1202's Needs verification.

**Decisions.**

- **What decides a rebuild?** Decided and built; carried here because the live run could reopen it.
  - **An application-level echo, rebuilding only if it goes unanswered (recommended).**
    - Pros: tests the terminal socket directly on every host, so a socket that stalled on its own is still replaced; a healthy one keeps every channel.
    - Cons: a protocol addition with a compatibility entry, and a stalled socket is replaced up to 2.5 s later.
  - **Keep foreground replacement on every return.**
    - Pros: recovers stalled connections at once with no protocol change.
    - Cons: keeps the per-return reconciliation this item is about.
  - **Limit the rebuild to mobile hosts and to a page hidden for longer than a short bound.**
    - Pros: a desktop alt-tab costs nothing and it needs no new frame.
    - Cons: rejected in review, because the main stream's silence path never fires when only the terminal socket stalls.
- **If 2.5 s proves too short on a slow link?**
  - **Raise `DEFAULT_FOREGROUND_PROBE_TIMEOUT_MS` to what the run shows (recommended).**
    - Pros: one constant; a false timeout costs only the old reconnect.
    - Cons: a dead mobile socket takes that much longer to replace.
  - **Scale the timeout from measured round trips.**
    - Pros: fits each link.
    - Cons: needs round-trip tracking this client does not have, for a failure that only costs a reconcile.

### 3. Input results past loopback Chromium

**Problem.** Each keystroke's input was answered by its own JSON `operation-result` frame. Input that succeeded now gets a cumulative `input-results` frame on a negotiated subprotocol, which has been seen working only in Chromium over loopback.

**Context.** The result carries a per-operation id that the client uses to settle a pending write. The client offers `orkestrator-terminal.v1.input-results` ahead of `orkestrator-terminal.v1`, so anything that picks v1 or passes only v1 still works with one result per input. The transport has an HTTP fallback.

**Investigation.** Proven here: the renderer's client against the real gateway (`apps/backend/tests/terminal-websocket-client-gateway.test.ts`), the relay keeping the leaf's choice in a Bun client (`gateway-command-nodes.test.ts`), and real Chromium on a real shell with both offers (1202 task 11's table). Not run: the Tailscale Serve route, a command-node relay driven from a browser, WebKit, a mobile WebView, and frame counts over a link with real latency, where key frames could arrive together and merge more often than on loopback.

**Decisions.**

- **How to check it?**
  - **Repeat the 1202 task 11 keystroke run on a real remote backend, in WebKit and on a phone (recommended).**
    - Pros: covers every untested hop with one script's worth of counting; also gives the real frame reduction on a link with latency.
    - Cons: needs a real remote host and a device.
  - **Rely on the fallback.**
    - Pros: no work; a proxy that drops the subprotocol header fails the upgrade and terminals fall back to HTTP/SSE.
    - Cons: a broken path would look like the transport being off, and the frame reduction stays unmeasured.
- **If a real link shows no frame reduction either?**
  - **Keep the frame: it is still smaller and adds no delay (recommended).**
    - Pros: nothing to change.
    - Cons: a second result format stays for a modest saving.
  - **Remove it once the compatibility window allows.**
    - Pros: one result format.
    - Cons: gives up the merge for bursts and the smaller frame.

## Constraints and rationale

- Terminal input must stay as responsive as it is today, so no batching may wait for a later keystroke.
- [Report invariants](../../reports/2026-10-27-efficiency.md#invariants-every-fix-must-keep): live events stay incremental with missed events detectable, and metrics stay content-free.
- Use an isolated `dev:test` profile for anything run locally; never point a check at a production instance.

## Related

- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md), tasks 3 and 11
- [0052 remote client bandwidth](../transcripts-and-observation/0052-remote-client-bandwidth.md) (terminal transport choice)
- [Version compatibility](../../architecture/version-compatibility.md#register)
