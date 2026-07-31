# Terminal WebSocket protocol v1

Status: specified; implementation in progress

This protocol replaces terminal input HTTP invokes and terminal output SSE
payloads for opted-in browser gateway clients. HTTP/SSE remains the fallback
transport. Backend terminal sessions and `get_terminal_output_snapshot` remain
authoritative; a socket, channel, or React component never owns terminal
lifetime.

The shared constants and TypeScript frame definitions live in
`packages/protocol/src/terminal-websocket.ts`.

## Upgrade and authentication

- Endpoint: `/__orkestrator/terminal`
- Required subprotocol: `orkestrator-terminal.v1`
- The gateway applies the same origin allow-list as its HTTP API. A browser
  `Origin` must be present and allowed before the upgrade is accepted.
- A same-origin client may authenticate with the gateway's `HttpOnly` cookie at
  upgrade time.
- A direct/bearer client sends `authenticate` as its first frame. Until that
  succeeds the connection is provisional: it receives no terminal data, may
  send no other frame, accepts at most the control-frame byte limit, and is
  closed after five seconds. Tokens never appear in URLs or logs.
- A missing subprotocol or unsupported version is rejected before upgrade with
  HTTP 426. A failed post-upgrade authentication closes with 4003. Authentication
  and origin failures never include the supplied token in metrics or logs.

## Control frames

Control frames are UTF-8 JSON text, limited to 16 KiB including UTF-8 encoding.
Each must decode to exactly one object with a recognized `type`. Unknown fields
may be ignored for forward compatibility; missing, incorrectly typed, or
out-of-range required fields are malformed.

Client frames:

- `authenticate { version, token? }`
- `subscribe { requestId, sessionId, knownGeneration?, knownRevision? }`
- `unsubscribe { channelId }`
- `resize { channelId, cols, rows }`
- `ack { channelId, generation, revision }`

Server frames:

- `ready { version, socketId }`
- `subscribed { requestId, sessionId, channelId, generation, revision, recovery }`
- `unsubscribed { channelId }`
- `lifecycle { channelId, state, generation, revision, exitCode? }`
- `desync { channelId, generation, revision, reason }`
- `error { code, message, requestId?, channelId?, fatal? }`

`requestId` is client allocated and correlates concurrent subscriptions.
`channelId` is an unsigned 16-bit integer allocated by the server, unique only
for the lifetime of one socket, and not reused until the prior subscription is
fully retired.

Every subscription is authorized independently after authentication. Knowing a
session ID does not bypass the gateway's terminal-session checks. Unsubscribe or
socket close releases only transport resources; neither stops nor detaches the
backend terminal process.

## Binary frames

Binary messages contain one complete frame, are limited to 256 KiB, and use
network byte order:

| Offset | Bytes | Field |
| --- | ---: | --- |
| 0 | 1 | type: `1` input, `2` output |
| 1 | 1 | flags, zero in v1 |
| 2 | 2 | channel ID |
| 4 | 4 | terminal generation |
| 8 | 8 | revision/input sequence |
| 16 | remaining | raw terminal bytes |

The revision is limited to JavaScript's safe unsigned integer range. Input
frames use a client-monotonic sequence number; output frames use the backend's
terminal output revision. Input is accepted only for the channel's current
generation. Output bytes are never base64 encoded.

## Ordering and recovery

WebSocket message order is the protocol order. A server processes input and
resize messages in arrival order per channel. It may execute independent
channels concurrently, but may not reorder frames within one channel.

Subscription follows the same subscribe-before-reconcile rule as gateway SSE:

1. Register for live backend terminal output.
2. Compare the supplied generation/revision with the retained terminal window.
3. Buffer concurrent channel output within the channel limits.
4. Send `subscribed` with `current`, `delta`, or `snapshot-required`.
5. Flush retained and concurrently buffered frames in revision order.

On a retained gap, `delta` output begins at `knownRevision + 1`. On generation
change, an expired cursor, reconnect without a cursor, or an explicit desync,
the adapter reads `get_terminal_output_snapshot` and treats it as authoritative.
It buffers newer socket output until that snapshot is applied. A revision jump
or duplicate generation change detected by the adapter triggers the same path.

After reconnect or an iOS foreground transition, the gateway adapter rebuilds
the socket from its authoritative desired-subscription registry. Components
register consumption; they do not own the connection or backend process.

## Backpressure and fairness

- Socket soft/hard queued-byte limits: 2 MiB / 8 MiB.
- Per-channel soft/hard queued-byte limits: 512 KiB / 2 MiB.
- Output scheduling is round-robin across channels with a bounded quantum.
- Crossing a channel soft limit drops only that channel's terminal output,
  emits `desync: slow-consumer`, and requires authoritative recovery.
- Authoritative control frames are never silently dropped.
- If a desync/control frame cannot fit, a channel reaches its hard limit, or
  the socket reaches its hard limit, the socket closes with 4008. Reconnect and
  snapshot recovery are then mandatory.

Acknowledgements report the highest output generation/revision the adapter has
applied. They do not replace snapshot cursors and do not authorize the server to
discard the backend's authoritative recovery window.

## Protocol errors

- Text over 16 KiB or binary over 256 KiB closes with 1009.
- Binary shorter than 16 bytes, non-zero v1 flags, invalid JSON, invalid fields,
  or an input/output direction violation receives a fatal `malformed-frame`
  error when it can be delivered, then closes with 4004.
- Unknown channels receive a non-fatal `unknown-channel` error. Repeated invalid
  channel traffic is a policy violation and closes with 1008.
- Unsupported binary data types close with 1003.

No error, metric, or log records terminal bytes, terminal snapshots, tokens, or
session content.
