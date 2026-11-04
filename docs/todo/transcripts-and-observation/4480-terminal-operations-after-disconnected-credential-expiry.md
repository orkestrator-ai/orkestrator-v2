# Queued terminal writes still run after a disconnected socket's credential lapses

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`, with the [3900](3900-terminal-operations-after-credential-rotation.md) change applied.

### Tasks

1. **Refuse a disconnected socket's queue when its own credential lapses**: input or a resize still queued from a socket that has disconnected must not reach the backend after that socket's credential expires or is revoked. Status: open.

### 1. Refuse a disconnected socket's queue when its own credential lapses

**Problem.** A client can queue terminal input behind a slow backend write and then disconnect. If its browser session or client grant then expires, or the session is signed out, the queued input still reaches the terminal once the slow write finishes.

**Context.** [3900](3900-terminal-operations-after-credential-rotation.md) made credential rotation and gateway stop refuse queued operations, including those of a socket that has already disconnected, by clearing `state.authenticated` through `revokeConnections()`. Expiry and per-session revocation work differently: each socket has its own `credentialExpiryTimer` and `unsubscribeRevocation` (`scheduleCredentialExpiry` in `apps/backend/src/terminal-websocket-server.ts`), and `dispose` clears both when the socket closes. After that, nothing can clear the flag for this credential. Durable tokens have no deadline, so this only concerns browser sessions and client grants. Rotation is not affected.

**Investigation.** A throwaway test on 2026-11-04 showed this against `TerminalWebSocketGateway` with stubbed credential callbacks. It blocked the first `terminal_write`, queued a second, terminated the socket and waited for it to be disposed. It then either made `tokenMatches` return false or called the `onCredentialRevoked` close callback, and released the first write. On both paths the backend received two `terminal_write` calls. This was not run through a real browser session or grant. The exposure is narrower than 3900's: the input was accepted while the credential was valid, the client must have disconnected first, and the existing bounds apply (`TERMINAL_WEBSOCKET_MAX_PENDING_OPERATIONS_PER_SESSION`, 256 operations, and 1 MiB per session).

**Decisions.**

- **How should a disposed socket learn its credential lapsed?**
  - **Keep its expiry timer and revocation subscription until its last queued operation settles (recommended).**
    - Pros: reuses the existing flag, callbacks and guard, so every path refuses the same way; costs nothing per operation; `pendingOperations` already says when the last one settles.
    - Cons: `dispose` no longer releases these unconditionally, so they need a second release point when the queue drains; the timer's re-arm branch has to run safely for a closed socket.
  - **Re-check `tokenMatches` when each queued operation's turn comes.**
    - Pros: one check in `enqueueOperation`, with no timers kept alive.
    - Cons: the state must keep the request and any supplied token after the socket has gone; for a bearer token the check runs `credentialThrottle.check`, which is the durable-token guess throttle, once per queued operation.

## Constraints and rationale

- A plain disconnect with a still-valid credential must keep running its queue. "preserves accepted input order across a socket reconnect" and "still runs the operations a plain disconnect left queued" in `apps/backend/tests/gateway-events.test.ts` pin this.
- The write already running in the backend cannot be recalled, and that is not part of this item.

## Related

- [3900-terminal-operations-after-credential-rotation.md](3900-terminal-operations-after-credential-rotation.md): rotation and gateway stop.
