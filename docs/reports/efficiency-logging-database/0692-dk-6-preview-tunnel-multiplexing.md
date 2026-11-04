# The preview tunnel opens a WebSocket per TCP connection

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Decide on multiplexing**: whether to run several streams over one socket per attachment. Status: open.

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
