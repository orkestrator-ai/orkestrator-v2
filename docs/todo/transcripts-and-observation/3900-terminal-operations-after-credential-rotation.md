# Queued terminal writes still run after credential rotation

## Task analysis

Analysed 2026-11-03 against `main` at `7b48c23f`.

### Tasks

1. **Refuse queued operations from a revoked socket**: an input or resize that a terminal WebSocket queued before a credential rotation or gateway stop must not reach the backend afterwards. Status: open.
2. **Regression test**: assert that a second write queued behind a blocked one is refused after rotation, and that the operation gauges still return to zero. Status: open (depends on 1).

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

## Related

- [0052-remote-client-bandwidth.md](0052-remote-client-bandwidth.md), task 4.
