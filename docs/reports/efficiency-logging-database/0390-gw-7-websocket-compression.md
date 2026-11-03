# No WebSocket message compression

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Prototype `permessage-deflate` if the WebSocket becomes the bulk transport**: deferred by 0052. Status: open.

### 1. Prototype `permessage-deflate` if the WebSocket becomes the bulk transport

**Problem.** Terminal WebSocket frames are uncompressed, which matters only if they prove large on remote links.

**Context.** Todo 0052 owns this as task 8. Its decision D6 chose to wait for the transport direction rather than prototype now. The terminal WebSocket is still opt-in.

**Investigation.** The server sets no compression option (`apps/backend/src/terminal-websocket-server.ts:193-198`), so this is unchanged since the report.

**Decisions.** None here: decided in 0052 (D6), and not reopened. When the work starts, the report asks for a threshold of about 1 KB, bounded memory, and a check under Bun's `ws` layer.

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): every compression buffer has byte and count bounds.

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-7)
- [0052 remote client bandwidth](../../todo/transcripts-and-observation/0052-remote-client-bandwidth.md), tasks 2, 5 and 8, decision D6
- [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), which leaves this with 0052
