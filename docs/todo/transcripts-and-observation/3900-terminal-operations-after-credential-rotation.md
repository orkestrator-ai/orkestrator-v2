# Queued terminal writes still run after credential rotation

## Task analysis

Analysed 2026-11-03 against `main` at `7b48c23f`. Acted on 2026-11-04 against `main` at `96ee1eb3e`; see Assumptions and decisions.

### Tasks

1. **Refuse queued operations from a revoked socket**: an input or resize that a terminal WebSocket queued before a credential rotation or gateway stop must not reach the backend afterwards. Status: done (2026-11-04).
2. **Regression test**: assert that a second write queued behind a blocked one is refused after rotation, and that the operation gauges still return to zero. Status: done (2026-11-04).

### 1. Refuse queued operations from a revoked socket

**Problem.** Rotating the gateway credential is meant to revoke every connection that authenticated with the old one (`setToken` in `apps/backend/src/gateway-lifecycle.ts`). The socket does close. But the terminal input it had already queued behind a slow backend write is still delivered to the terminal once that write finishes, after the old credential stopped being valid.

**Context.** Found during 0052 task 4 ([0052](0052-remote-client-bandwidth.md)). Terminal operations go through one ordering tail per session, owned by the gateway rather than by the socket, so that a reconnect cannot overtake input that was already accepted (`enqueueOperation` in `apps/backend/src/terminal-websocket-server.ts`; "preserves accepted input order across a socket reconnect" in `apps/backend/tests/gateway-events.test.ts`). Each queued step checks `options.state.authenticated` before it calls the backend, and throws "Terminal credential revoked" when the flag is false. Only the session-revocation callback in `scheduleCredentialExpiry` sets that flag to false. `revokeConnections()`, which both rotation and `close()` (gateway stop) call, only terminates the sockets. The credential-expiry timer does not clear it either.

**Investigation.** A throwaway test showed this on 2026-11-03. The setup:

- a backend whose first `terminal_write` blocks;
- two input frames on one channel, both queued;
- `setToken` to a new value, waiting for the socket to close, then releasing the first write.

The backend received two `terminal_write` calls, where one was expected. The exposure is bounded: the operations were accepted while the old credential was valid, and at most `TERMINAL_WEBSOCKET_MAX_PENDING_OPERATIONS_PER_SESSION` (256) and 1 MiB per session can be waiting. The write already running in the backend cannot be recalled, and that is not part of this item. The 0052 test "returns compressor count and queued bytes to zero after credential rotation and gateway stop" pins that behaviour.

**Decisions.**

- **Where to clear the flag?**
  - **Set `state.authenticated = false` for every socket in `revokeConnections()`, before terminating it, and in the credential-expiry timer's close branch (recommended).**
    - Pros: one line per site; reuses the existing guard and its "Terminal credential revoked" result; covers rotation, gateway stop and expiry alike.
    - Cons: a plain disconnect still runs its queued input, which is intended (the reconnect-order test depends on it), so a reader has to see that the revocation and disconnect paths differ on purpose.
  - **Drain and refuse the session's queued operations directly in `revokeConnections()`.**
    - Pros: releases the queued bytes at once instead of after the running write.
    - Cons: the tail is a promise chain, not a list, so this needs a new cancellation structure; more code for the same outcome.

### 2. Regression test

**Problem.** Nothing would catch this coming back.

**Context.** The throwaway test above is the shape to keep. It belongs next to "acknowledges rejected operations and bounds a blocked per-session queue" in `apps/backend/tests/gateway-events.test.ts`.

**Investigation.** The 0052 rotation-and-stop test already shows that the gauges reach zero once the backend settles the write it accepted. This test adds the refusal of the second write.

**Decisions.**

- **What to assert?**
  - **Count `terminal_write` calls, and check that the operation count and bytes drain to zero (recommended).**
    - Pros: proves the backend never saw the input, which is what matters; the gauge check keeps the 0052 guarantee.
    - Cons: says nothing about the result frame, which is not sent anyway once the socket has closed.
  - **Expect a refused operation result for the queued write.**
    - Pros: covers the result path.
    - Cons: the socket is already closed when the write is refused, so there is no frame to read; it would need a socket that stays open, which rotation never leaves.

## Assumptions and decisions

### Task 1: cleared the flag at both recommended sites

Took the recommended option. `revokeConnections()` sets `state.authenticated = false` before terminating each socket, which covers rotation and gateway stop, and the credential-expiry timer's close branch sets it too. An expired browser session already cleared the flag, because `BrowserSessions.matches()` revokes the session and fires its listener; the timer's own assignment is what covers an expiring client grant. The guard in `enqueueOperation` and its "Terminal credential revoked" path are unchanged.

### Task 1: extended revocation to sockets that disconnected first

The recommended sites do not reach a socket that disconnected before the revocation, because `dispose` removes it from `sockets` while its input is still waiting on the session's tail. A test on the old code showed all of that input reaching the backend. Since the task covers any input queued before a rotation or stop, the gateway now also tracks sockets with queued operations (`operationSockets`, counted by `SocketState.pendingOperations`), and `revokeConnections()` clears the flag on those as well. Each entry leaves when its last operation settles. The closures on the tail already held these states, so this adds no retention and stays within the existing operation bounds.

### Task 1: left a disconnected socket's own expiry or revocation to a new file

A socket that disconnected and whose own credential then expired or was revoked still ran its queue, because `dispose` dropped its timer and revocation subscription. That needed a different mechanism and has since been done: a disconnected socket keeps both until its last queued operation settles, and client grants now publish their revocation. See [`remote-gateway.md`](../../architecture/remote-gateway.md#compression-and-terminal-transport).

### Task 2: tested at the backend boundary, with deterministic expiry

Took the recommended option: the tests record each `terminal_write` and `terminal_resize` the backend receives and check the operation gauges drain to zero. They are in `apps/backend/tests/gateway-events.test.ts`, next to the bounded-queue test, and queue two inputs and a resize behind a blocked write.

- **Rotation and stop** run through a real gateway, each with an open socket and with one that disconnected first.
- **Expiry** drives `TerminalWebSocketGateway` directly. Its `credentialExpiresAt` keeps the timer re-arming while `tokenMatches` holds, so the test picks the moment of expiry rather than waiting out a deadline.
- **A plain disconnect** has its own test, which pins that all three operations still run. "preserves accepted input order across a socket reconnect" passes unchanged.

Before the fix, all five revocation cases failed with `["terminal_write", "terminal_write", "terminal_resize"]` reaching the backend, while the plain-disconnect and reconnect-order tests passed.

### Kept this file after finishing it

`docs/README.md` says a finished file is normally deleted once its durable behaviour has moved. The ticket requires this file to record the outcome, so it stays, marked Finished. The durable behaviour is in [`remote-gateway.md`](../../architecture/remote-gateway.md#compression-and-terminal-transport).

## Related

- [0052-remote-client-bandwidth.md](0052-remote-client-bandwidth.md), task 4.
