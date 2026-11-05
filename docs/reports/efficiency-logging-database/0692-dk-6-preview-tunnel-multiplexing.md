# The preview tunnel opens a WebSocket per TCP connection

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Decide on multiplexing**: whether to run several streams over one socket per attachment. Status: done (2026-11-04: multiplexed as tunnel v2, see [4500](../../todo/cross-cutting/4500-preview-tunnel-one-socket-per-connection.md)).

### 1. Decide on multiplexing

**Problem.** Each tunnelled connection pays a WebSocket handshake plus HELLO and OPEN.

**Context.** The report rates this Low, with Medium confidence. 1202 records that Electron's local ingress already pools its tunnel connections.

**Investigation.** `openPreviewTunnel` opens one socket per stream (`apps/desktop/electron/preview-tunnel-client.ts:130-150`). HELLO and OPEN are pipelined, so that part costs no extra round trip (`:133`). `preview-transport-manager.ts` keeps a pool per service group (`apps/desktop/electron/preview-transport-manager.ts:135`, opening at `:903`), so a repeat request can reuse a tunnel rather than open a new one.

**Decisions.**

- **Multiplex?**
  - **Leave it, unless a remote page-load measurement shows handshakes dominate (recommended).**
    - Pros: the pool already removes most repeats; no new framing, flow control or per-stream fairness to maintain.
    - Cons: a page's first burst still opens several sockets.
  - **Multiplex streams over one socket per attachment, as the report suggests.**
    - Pros: one handshake per attachment.
    - Cons: a new tunnel protocol version (`PREVIEW_TUNNEL_SUBPROTOCOL`, `packages/protocol/src/preview-access.ts:145`) with flow control, where one slow stream must not stall the others.

## Constraints and rationale

An attachment credential must still bound what a stream can reach, and revocation must close every stream.

## Needs verification

- First-load cost over a real remote link. The existing `vite-page-load.spec.ts` measurement covers the private origin, not this tunnel.

## Related

- [Efficiency report, G](../2026-10-27-efficiency.md#g-desktop-toolchain-docker-image-protocol-and-cli)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), tasks 11 and 12

## Outcome

Checked back against the code on 2026-11-05 at `main` `69a3b4ca5`, before this file was deleted. The tests named were run on that commit and pass.

| Task | Outcome | Code, evidence or to-do |
| --- | --- | --- |
| 1. Decide on multiplexing | Done (multiplexed) | The file recommended leaving it; [4500](../../todo/cross-cutting/4500-preview-tunnel-one-socket-per-connection.md) task 2 built it instead as tunnel v2 (`orkestrator.preview-tunnel.v2`, `packages/protocol/src/preview-tunnel-mux.ts`), negotiated through the attachment with v1 kept for older peers. Backend `apps/backend/src/preview-tunnel-mux-server.ts`, desktop `apps/desktop/electron/preview-tunnel-session.ts`. Tests: `several HTTP exchanges share one authenticated socket, each on its own upstream` and `attachments advertise v2, and a client offering only v1 still gets v1` (`preview-tunnel-mux-server.test.ts`); `parallel opens share one handshake and HELLO, and the session closes once idle` and `an attachment without v2, or a server answering v1, gets one v1 socket per connection` (`apps/desktop/tests/preview-tunnel-session.test.ts`). |
| Con of multiplexing: one slow stream must not stall the others | Done | Per-stream credit. Tests: `a stream whose reader stopped stalls at its window without stalling another` (backend); `a stopped reader stalls only its own stream, and resumes with credit` (desktop). |
| Constraint: the attachment credential bounds what a stream reaches, and revocation closes every stream | Done | Tests: `revocation closes the session and every stream on it` and `streams cannot be opened before HELLO, nor beyond the per-session bound` (backend); `revocation fails the session's streams and the next open is refused` and `a session error frame fails its streams before the close frame arrives` (desktop). |
| Needs verification: first-load cost over a real remote link | Moved to a to-do | Not measured. Already open as [4500](../../todo/cross-cutting/4500-preview-tunnel-one-socket-per-connection.md) task 1 and its "Needs verification", which now names this report. |
