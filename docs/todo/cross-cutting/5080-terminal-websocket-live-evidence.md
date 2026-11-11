# Terminal WebSocket: live evidence left from efficiency report 0100

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`.

What was left of `docs/reports/efficiency-logging-database/0100-e19-terminal-websocket.md` (batch E19) once its code was done. That report is deleted; read it with `git show e198fd4a7:docs/reports/efficiency-logging-database/0100-e19-terminal-websocket.md`. The work itself and its numbers are in to-do 1202 task 11 (retired 2026-11-10) and task 3.

### Tasks

3. **Input results past loopback Chromium**: part `0375` (GW-16) task 3, the hops an agent can reach (WebKit, a command-node relay driven from a browser, a link with added latency). Status: open.

### 3. Input results past loopback Chromium

**Problem.** Each keystroke's input was answered by its own JSON `operation-result` frame. Input that succeeded now gets a cumulative `input-results` frame on a negotiated subprotocol, which has been seen working only in Chromium over loopback.

**Context.** The result carries a per-operation id that the client uses to settle a pending write. The client offers `orkestrator-terminal.v1.input-results` ahead of `orkestrator-terminal.v1`, so anything that picks v1 or passes only v1 still works with one result per input. The transport has an HTTP fallback.

**Investigation.** Proven here: the renderer's client against the real gateway (`apps/backend/tests/terminal-websocket-client-gateway.test.ts`), the relay keeping the leaf's choice in a Bun client (`gateway-command-nodes.test.ts`), and real Chromium on a real shell with both offers (1202 task 11's table). Not run: a command-node relay driven from a browser, WebKit, and frame counts over a link with added latency, where key frames could arrive together and merge more often than on loopback. The Tailscale Serve route, a real remote backend and a phone's WebView are in the manual-test checklist (7568: 5080 task 3).

**Decisions.**

- **How to check it?**
  - **Repeat the 1202 task 11 keystroke run in Playwright WebKit and through a command-node relay between two `dev:test` profiles on one host, with latency added to the link (recommended).**
    - Pros: covers every hop an agent can reach with one script's worth of counting; gives a frame reduction on a link with latency.
    - Cons: added latency is not a real remote link; the real remote host and phone are a separate manual check.
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
- Report invariants (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`): live events stay incremental with missed events detectable, and metrics stay content-free.
- Use an isolated `dev:test` profile for anything run locally; never point a check at a production instance.

## Related

- to-do 1202 efficiency follow-ups, tasks 3 and 11 (retired 2026-11-10)
- 0052 remote client bandwidth (retired 2026-11-11; [remote-bandwidth.md](../../development/remote-bandwidth.md#what-is-settled)): the terminal transport stays the shared SSE stream
- [Version compatibility](../../architecture/version-compatibility.md#register)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, task 2, the user part of task 3: a real remote backend over Tailscale Serve and a phone) moved there on 2026-11-10.
