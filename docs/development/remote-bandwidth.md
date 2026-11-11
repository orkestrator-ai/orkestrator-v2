# Remote client bandwidth

How much a remote browser (over the tailnet, the hosted web client, iOS) pays
in bytes and requests, how that was measured, and the decisions the numbers
settled. This is the durable record of to-do 0052 (retired 2026-11-11; the
file is in Git history at `498b68766`, under
`docs/todo/transcripts-and-observation/0052-remote-client-bandwidth.md`). The
gateway behaviour itself is described in
[remote-gateway.md](../architecture/remote-gateway.md); the data-saving
cadences in [recurring-work.md](../architecture/recurring-work.md).

## What is settled

- **Compression is `on` by default** (since 2026-11-01): direct and proxied
  event streams are gzipped, each frame sync-flushed. `--compression body` (or
  `ORKESTRATOR_GATEWAY_COMPRESSION=body`) is the rollback, and the control
  listener is always `off`. Streaming gzip contexts share a ceiling of eight
  (`MAX_CONCURRENT_STREAMING_COMPRESSIONS`); past it a stream continues as
  identity. A browser holds two streams (main and the shared terminal stream),
  so four browsers fill the pool.
- **The terminal transport stays the shared SSE stream** (decided 2026-11-11 on
  the single-host matrix below). With `on`, a burst of redundant build output
  costs a client about 19 KiB over SSE against 239 KiB over the opt-in
  WebSocket, and on a 512 kbit/s link the SSE burst reaches the client in
  0.35 s against 4.7 s. The WebSocket ties only on random output. It stays
  opt-in (`terminalTransport` or the `orkestrator-terminal-transport` key).
- **No `permessage-deflate` for the terminal WebSocket** while it is opt-in.
  If a later decision makes the WebSocket the remote terminal transport, see
  [If the WebSocket becomes the terminal transport](#if-the-websocket-becomes-the-terminal-transport).
- **Hidden terminal tabs stay subscribed** (decided 2026-10-27, measured
  2026-11-11). A background tab of the open environment receives exactly what a
  visible one does (about 18 KiB per build burst under `on`, 248 KiB under
  `body`). Detaching it is allowed only where recovery is exact, and the
  terminal state snapshot keeps the current screen exactly but halves
  scrollback to fit its byte target (`serializedState` in
  `apps/backend/src/core/terminal-history.ts`), so a detached tab would come
  back with less history. Other environments' terminals are already
  unmounted: only the selected environment's `TerminalContainer` mounts.
- **Data saving is a client-local preference, off by default** (Settings >
  General, `uiStore.dataSaving`, trial values in
  `apps/web/src/lib/data-saving-policy.ts`). It slows only backstop polls of the
  requesting client: a running native view's backstop goes from 500 ms to 1 s,
  the Files panel's All files poll backs off through 10, 15 and 30 s on a
  watched worktree (10 s on an unwatched target), and a running reviewer tab
  through 8, 15 and 30 s. Invalidations, explicit refreshes, resume and
  reconnect are never slowed, so approvals and completions keep
  recurring-work's 2 s and 3 s budgets. Measured live on 2026-11-11: 40 % fewer
  bytes on a running turn and 75 % fewer Files panel reads, with approvals and
  completions as fast as without it. It is kept as it is; widening it waits on
  a remote measurement that shows a need.
- Benefit is always shown in encoded or framed bytes, never inferred from
  serialised size, and one client's preference never changes a shared
  backend's cadence for other clients.

Still open, all on the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)
(items citing `0052 (retired)`): the same matrix through Tailscale Serve from
a second machine with a real browser, exact terminal recovery after
backpressure and a reconnect over that real link, and a real device's screen
lock and resume with data saving on.

## Harnesses

| Harness | What it measures |
| --- | --- |
| `e2e/agent-testing/remote-bandwidth-live.spec.ts` | The single-host matrix: real browsers on a real `dev:test` gateway and Claude CLI with a loopback model, per compression mode, terminal transport and link, plus data saving side by side. Each cell is recorded with an outcome (`qualified`, `incomplete`, `over-budget`) and the run fails unless every cell qualified. How to run it: [agent-testing.md](agent-testing.md#remote-bandwidth-matrix-fake-model). |
| `e2e/agent-testing/remote-bandwidth-meter.ts` | The per-client loopback link the spec uses: exact wire bytes per request class and per invoke command, with optional rate and latency shaping in both directions (kbit/s of 1,000 bits, as the baseline's limiter). Requests are parsed incrementally, so TCP splits do not change attribution; a peer's end of stream waits behind its queued bytes; a destination that stops reading gets nothing more until it drains, and its buffered bytes count against the queue bound. |
| `e2e/agent-testing/remote-bandwidth-qualification.ts` | The spec's arithmetic (completion from the model's last delta, last stream byte) and its pass rule: expected sample counts, finished and settled terminal bursts, p95 budgets. |
| `apps/backend/scripts/remote-bandwidth-baseline.ts` | The real gateway in process against synthetic workloads (temporary data directory, ephemeral port, random token never printed): aggregate bytes, latency, CPU, heap and gauges, with one slow client that never reads. `--rate-kbps`/`--latency-ms` put each client behind a userspace limiter. |
| `apps/backend/scripts/sse-route-probe.ts` | Whether a route holds or re-encodes a gzip event stream (timestamped ticks, client against gateway bytes). |
| `e2e/SseGzipStreaming.spec.ts`, `apps/backend/tests/gateway-sse-gzip-routes.test.ts` | Incremental gzip SSE directly, through HTTP/1.1 and HTTP/2 test proxies, and in Chromium, Firefox and WebKit. |
| `e2e/DataSavingGateway.spec.ts` | Two isolated browser clients with different data-saving preferences against a disposable gateway: reload, hidden and resume, a dropped stream, response bytes and approval and completion latency. |

## Measurements

All figures below were taken on hosts busy with other builds; CPU and latency
are noisy, bytes are not.

### Live single-host matrix, 2026-11-11

`remote-bandwidth-live.spec.ts` at `498b68766` on `beelink2` (Linux x64, 16
cores, load average 8 to 39 during the runs), profile `rbw52`, Claude CLI
against the loopback model, three headless Chromium clients on one Claude
session and one environment's two terminal tabs (one visible, one in the
background). "Slow link" is each client's own 512 kbit/s link with 40 ms each
way, shaped in the client's loopback relay. Bytes are what crossed each
client's link (HTTP headers and WebSocket framing included), averaged over the
three clients. The gateway's compressor peak was 6 in every `on` cell (three
browsers, two streams each), with no declines, failures, soft desyncs or
dropped streams anywhere.

Idle (an open session and two quiet terminals, 20 s): about 17 KiB a minute per
client in every mode, transport and link, almost all of it invoke backstop
reads (`get_system_usage`, the native view's backstop); the event streams sent
nothing in the window (keepalives are 25 s apart). One cell (`body`, SSE,
loopback) read 52 KiB a minute because of extra backstop reads in its window.

A streamed agent turn (200 lines, one every 25 ms, sent by client 1, watched by
all three; three rounds). The transcript reaches a client through invoke reads
of its live update, which are compressed in both modes; the event stream only
invalidates. Latency is from the model's first delta to the first line in each
client, and from the model's last delta to the last line:

| Mode | Transport | Link | KiB per client per turn (sender / watchers) | Of which events | First update p50 / p95 ms | Completion p50 / p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| on | SSE | loopback | 38.9 / 32.5, 33.5 | 0.8 | 575 / 669 | 615 / 905 |
| on | SSE | slow | 33.1 / 21.2, 21.2 | 0.2 | 693 / 938 | 723 / 947 |
| on | WebSocket | loopback | 33.4 / 27.8, 27.8 | 0.5 | 641 / 674 | 654 / 689 |
| on | WebSocket | slow | 39.3 / 28.2, 28.8 | 0.5 | 652 / 673 | 693 / 703 |
| body | SSE | loopback | 44.7 / 39.1, 39.2 | 6.9 | 616 / 674 | 641 / 908 |
| body | SSE | slow | 39.0 / 33.1, 33.3 | 4.0 | 688 / 927 | 703 / 1,208 |
| body | WebSocket | loopback | 32.3 / 29.4, 26.9 | 2.6 | 637 / 671 | 648 / 682 |
| body | WebSocket | slow | 33.5 / 24.3, 24.3 | 2.6 | 724 / 998 | 757 / 1,012 |

Every client paid for the turn separately: a watcher costs nearly what the
sender does (multi-client bytes scale with clients; nothing is shared on the
wire). All completions were inside the 3 s budget.

Terminal bursts, written to a terminal session through the backend: 4,000
lines of redundant build output (about 500 KiB of serialised SSE per stream),
the same in the background tab, and 150,000 random bytes as base64 (about
205 KiB). KiB is the terminal bytes each client received; "last byte" is from
the write to the last stream byte reaching the client (one burst per cell):

| Mode | Transport | Link | Build KiB | Build last byte ms | Background tab KiB | Background last byte ms | Random KiB | Random last byte ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| on | SSE | loopback | 19.3 | 580 | 18.3 | 49 | 152.1 | 1,009 |
| on | SSE | slow | 18.6 | 353 | 18.5 | 870 | 152.1 | 2,739 |
| on | WebSocket | loopback | 238.8 | 467 | 238.8 | 44 | 200.2 | 1,014 |
| on | WebSocket | slow | 238.9 | 4,659 | 238.8 | 3,793 | 200.3 | 3,200 |
| body | SSE | loopback | 249.4 | 593 | 248.2 | 103 | 209.4 | 881 |
| body | SSE | slow | 254.0 | 4,846 | 247.9 | 3,929 | 204.5 | 3,255 |
| body | WebSocket | loopback | 238.9 | 78 | 238.9 | 79 | 200.2 | 947 |
| body | WebSocket | slow | 238.8 | 5,210 | 238.8 | 3,813 | 200.2 | 3,191 |

Findings:

- `on` SSE carries redundant terminal output in about a thirteenth of the
  WebSocket's bytes (19 against 239 KiB) and keeps a 512 kbit/s link at its
  latency, where the WebSocket and `body` SSE take 4 to 5 s to deliver the
  same burst. On random output `on` still saves about a quarter (152 against
  200 to 209 KiB). This is what decided the terminal transport.
- A background terminal tab costs exactly as much as a visible one.
- The WebSocket's mode-independence shows: it is uncompressed in both modes.
- The slow link's queue held up to 19 KiB per client for an `on` build burst
  and about 250 KiB for the WebSocket and `body`.

### Data saving in real browsers, 2026-11-11

The same spec and profile, `on` mode, shared SSE terminal stream, loopback:
client 1 with data saving off, client 2 with it on, both on one Claude session
in an environment whose composer was set to Claude's "ask" approval mode. The
byte cells come from one run; the completion row spans five runs and the
approval row three, five rounds each.

| Cell | Data saving off | Data saving on |
| --- | --- | --- |
| Running turn held at "provider working", 30 s | 95.1 KiB, 71 invokes (62 live-update reads) | 57.1 KiB, 40 invokes (32 live-update reads) |
| Idle native view, 30 s | 6.8 KiB, 9 invokes | 6.8 KiB, 10 invokes |
| Files panel, All files tab, watched quiet worktree, 60 s | 38.8 KiB, 43 invokes (12 file-tree and 12 git-status reads) | 28.7 KiB, 25 invokes (3 and 3) |
| Files panel, Changes tab, 60 s | no Files panel read | no Files panel read |
| Completion, release to answer visible, p50 / p95 ms (3 s budget) | 351 to 569 / 355 to 864 | 345 to 567 / 363 to 887 |
| Approval, backend parked to card visible, p50 / p95 ms (2 s budget) | 55 to 60 / 102 to 235 | 60 to 145 / 220 to 265 |

The backend parked each approval 205 to 358 ms (p50) after the model's tool
call. The Changes tab is owned by the event-driven change projection, so it
never polls; data saving changes nothing there. Idle native views were already
backed off for every client. The reviewer tab's backoff was not run live (it
needs a running Multi Review); its read counts are the fake-clock figures
below.

`e2e/DataSavingGateway.spec.ts` passed on the same host and day (desktop and
mobile Chromium projects): over 4.2 s the data-saving client made 5 reads
(390 body bytes) against 8 and 9 (624 and 702), and approvals and completions
reached both clients in 12 to 40 ms.

### In-process baseline, Linux, 2026-11-11

`remote-bandwidth-baseline.ts --sessions 1,4 --duration-ms 6000 --idle-ms 2000`,
then the same with `--idle-ms 3000 --rate-kbps 512 --latency-ms 40`, at
`498b68766` on `beelink2` (load average 34 to 39). KiB a minute per healthy
client, latency p95 in ms; one slow client that never reads:

| Workload | Terminals | body | on | WebSocket | Slow link p95 body / on / WebSocket |
| --- | --- | --- | --- | --- | --- |
| interactive | 4 | 163.7 | 66.9 | 66.7 | 46.5 / 52.9 / 43.0 |
| build | 1 | 4,094 | 495 | 3,815 | 2,566 / 47.3 / 1,993 |
| build | 4 | 16,376 | 1,842 | 15,206 | 7,040 / 55.5 / 7,048 |
| incompressible | 4 | 18,540 | 14,167 | 17,928 | 7,260 / 6,845 / 7,156 |
| agent events | 0 | 345.5 | 38.5 | 345.4 | 44.5 / 45.2 / 42.7 |
| agent + build | 4 | 16,775 | 1,843 | 15,445 | 6,858 / 53.5 / 6,868 |

The ratios match the macOS run below. Unlike it, no slow client was soft
desynced in any case here. On the slow link the `body` and WebSocket cases
with four build terminals had not delivered 2,500 to 2,700 frames when the
case ended, and `on` had delivered every frame.

### Live probe through Tailscale Serve, 2026-11-01

`sse-route-probe.ts` at `0bd214ee4`. Server node `omarchy-hp` (Linux, Tailscale
1.104.1), client a Mac on the same LAN over a direct tailnet path (Tailscale
1.102.4). Each run sent 30 ticks at 1 s, a 60 s idle gap and one last tick, using
a browser's `Accept-Encoding` unless stated. The node's existing Serve handler on
443 was left alone; the probe used 8443 and removed it afterwards.

| Run | Encoding | Missing / duplicates | Held ticks | Delay p50 / p95 / max ms | Keepalives | Client vs gateway bytes |
| --- | --- | --- | --- | --- | --- | --- |
| Serve, HTTP/2 | gzip | 0 / 0 | 0 | 1 / 2 / 10 | 4 | 941 = 941 |
| Serve, HTTP/1.1 | gzip | 0 / 0 | 0 | 1 / 2 / 64 | 5 | 976 = 976 |
| Direct tailnet (control) | gzip | 0 / 0 | 0 | 2 / 53 / 68 | 4 | 940 = 940 |
| Serve, `identity` | none | 0 / 0 | 0 | 1 / 48 / 53 | 5 | 4,260 = 4,260 |
| Serve, reconnect after tick 10 | gzip | 0 / 0 | 0 | 1 / 35 / 83 | 5 | n/a across two connections |

Findings: Serve neither holds nor re-encodes gzip SSE, a quiet stream survives
the 60 s gap, and a reconnect replays with no loss or duplicate
(`streamingActiveAfterClose` was 0 in every run). This workload is 4.5 times
smaller with gzip. It is a slow synthetic stream on a good link, so it proves
route behaviour, not bandwidth or CPU under load.

### In-process baseline, macOS, 2026-10-27

Command: `mise exec -- bun apps/backend/scripts/remote-bandwidth-baseline.ts
--sessions 1,4 --duration-ms 6000 --idle-ms 2000` at `863b5782`, macOS arm64,
Bun 1.4.4, on a machine busy with other builds (CPU figures are noisy and
include the clients, which share the process). Three healthy clients and one
slow client that never reads; keepalive scaled to 5 s (production 25 s);
loopback, no limiter. Bytes are TCP bytes a healthy client read, per minute.
Latency is emit to arrival over every frame; "Missing" counts frames a healthy
client never received.

| Workload | Terminals | Transport | KiB/min per client | Source KiB | Encoded/framed KiB | p50 / p95 ms | CPU ms | Compressors peak | Slow-client desyncs | Missing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| quiet | 1 | body / on / websocket | 0.3 / 0.4 / 0.1 | 0.1 | 0.1 | n/a | 7 / 11 / 8 | 0 / 8 / 0 | 0 | 0 |
| interactive | 1 | body | 41.5 | 21.2 | 21.2 | 0.3 / 1.6 | 41 | 0 | 0 | 0 |
| interactive | 1 | on | 18.0 | 21.2 | 8.6 | 0.9 / 5.3 | 36 | 8 | 0 | 0 |
| interactive | 1 | websocket | 17.2 | 6.4 | 9.1 | 0.3 / 0.8 | 36 | 0 | 0 | 0 |
| interactive | 4 | body | 163.7 | 83.6 | 83.6 | 0.2 / 0.6 | 31 | 0 | 0 | 0 |
| interactive | 4 | on | 66.9 | 83.6 | 32.0 | 1.6 / 11.3 | 72 | 8 | 0 | 0 |
| interactive | 4 | websocket | 66.7 | 24.6 | 35.6 | 0.2 / 0.6 | 37 | 0 | 0 | 0 |
| build | 1 | body | 3,774 | 2,007 | 2,007 | 0.2 / 0.9 | 95 | 0 | 0 | 0 |
| build | 1 | on | 469 | 2,051 | 244 | 0.6 / 3.5 | 218 | 8 | 0 | 0 |
| build | 1 | websocket | 3,517 | 1,856 | 1,877 | 0.2 / 0.5 | 94 | 0 | 0 | 0 |
| build | 4 | body | 15,259 | 7,903 | 7,903 | 0.2 / 0.6 | 150 | 0 | 115 | 0 |
| build | 4 | on | 1,723 | 8,144 | 893 | 0.6 / 5.6 | 508 | 8 | 0 | 0 |
| build | 4 | websocket | 14,070 | 7,422 | 7,507 | 0.2 / 0.7 | 163 | 0 | 0 | 0 |
| incompressible | 1 | body | 4,352 | 2,313 | 2,313 | 0.2 / 0.5 | 90 | 0 | 0 | 0 |
| incompressible | 1 | on | 3,297 | 2,297 | 1,752 | 0.5 / 4.8 | 261 | 8 | 0 | 0 |
| incompressible | 1 | websocket | 4,163 | 2,200 | 2,222 | 0.2 / 1.5 | 102 | 0 | 0 | 0 |
| incompressible | 4 | body | 17,340 | 8,731 | 8,731 | 0.2 / 0.4 | 129 | 0 | 233 | 0 |
| incompressible | 4 | on | 13,316 | 9,056 | 6,104 | 0.5 / 2.9 | 509 | 8 | 110 | 0 |
| incompressible | 4 | websocket | 16,719 | 8,832 | 8,918 | 0.3 / 0.5 | 174 | 0 | 0 | 0 |
| agent events | 0 | body | 345 | 183 | 183 | 0.2 / 0.5 | 29 | 0 | 0 | 0 |
| agent events | 0 | on | 38.5 | 183 | 19.1 | 0.3 / 1.0 | 36 | 8 | 0 | 0 |
| agent events | 0 | websocket | 340 | 180 | 180 | 0.2 / 0.3 | 23 | 0 | 0 | 0 |
| agent + build | 1 | body | 4,203 | 2,233 | 2,233 | 0.2 / 0.3 | 105 | 0 | 0 | 0 |
| agent + build | 1 | on | 505 | 2,226 | 262 | 0.5 / 4.0 | 220 | 8 | 0 | 0 |
| agent + build | 1 | websocket | 3,941 | 2,079 | 2,101 | 0.2 / 0.5 | 110 | 0 | 0 | 0 |
| agent + build | 4 | body | 15,719 | 8,130 | 8,130 | 0.2 / 0.4 | 138 | 0 | 123 | 0 |
| agent + build | 4 | on | 1,763 | 8,326 | 913 | 0.6 / 5.3 | 492 | 8 | 0 | 0 |
| agent + build | 4 | websocket | 14,727 | 7,768 | 7,855 | 0.2 / 0.4 | 153 | 0 | 0 | 0 |

WebSocket ACK frames per output frame: 0.25 for 50 ms bursts, 0.75 for
interactive bursts. The slow WebSocket client was never desynced within a
case; its queue peaked at 1.1 to 1.5 MiB with four build terminals.

Findings:

- `on` cuts redundant output and agent events 8 to 9 times and random
  printable output about 25 %, for 2 to 3 times the CPU of `body` (clients
  included) and a few ms of extra p95 latency. No frame was buffered or lost.
- Removing SSE and JSON overhead (the WebSocket) matches `on` only for small
  interactive frames; for bulk output it saves about 7 %, so it does not meet
  a bandwidth target on its own.
- Every `on` case ran the compressor pool full: three healthy browsers plus
  the slow one hold eight streams. A fifth browser would get identity.
- A slow SSE client is desynced at the soft limit (the expected recovery
  path); with `on`, compression keeps it under the limit for redundant output.

### In-process constrained link, macOS, 2026-10-27

Same harness and build, `--rate-kbps 512 --latency-ms 40 --idle-ms 3000`: each
client connection behind its own 512 kbit/s, 40 ms userspace limiter.
"Backlog" counts frames still queued behind the link when the case ended
(9 s); no stream was dropped or desynced in any case.

| Workload | Terminals | Transport | KiB/min per client | p50 / p95 ms | Completion ms | Backlog frames |
| --- | --- | --- | --- | --- | --- | --- |
| quiet | 1 | body / on / websocket | 0.2 / 0.3 / 0.2 | n/a | n/a | 0 |
| interactive | 1 | body / on / websocket | 36.9 / 16.0 / 15.4 | ~44 / ~45 all | ~44 | 0 |
| interactive | 4 | body / on / websocket | 145.5 / 59.5 / 59.4 | ~44 / ~44 all | ~43 | 0 |
| agent events | 0 | body / on / websocket | 302 / 33.7 / 307 | ~44 / ~44 all | ~43 | 0 |
| build | 1 | body | 3,466 | 1,211 / 2,230 | 2,332 | 0 |
| build | 1 | on | 415 | 43.5 / 43.9 | 42 | 0 |
| build | 1 | websocket | 3,265 | 963 / 1,720 | 1,878 | 0 |
| build | 4 | body | 3,761 (link full) | 3,614 / 6,950 | not reached | 2,418 |
| build | 4 | on | 1,538 | 44.7 / 51.6 | 54 | 0 |
| build | 4 | websocket | 3,769 (link full) | 3,596 / 6,870 | not reached | 2,349 |
| incompressible | 1 | body | 3,742 | 1,691 / 3,099 | not reached | 45 |
| incompressible | 1 | on | 3,039 | 695 / 1,280 | 1,340 | 0 |
| incompressible | 1 | websocket | 3,750 | 1,577 / 2,892 | not reached | 12 |
| incompressible | 4 | body / on / websocket | ~3,800 each (link full) | ~3,500-3,800 / ~6,900-7,300 | not reached | 2,296-2,544 |

Findings: on a 512 kbit/s link one terminal of build output already saturates
`body` and the WebSocket (seconds of terminal lag), while `on` keeps it at the
link's latency, and four terminals stay under 55 ms p95 only with `on`. Small
interactive frames and quiet streams are latency-bound in every mode.

### Data-saving read budget (fake clock)

`apps/web/src/lib/data-saving-policy.test.ts` runs the coordinator on a fake
clock with the demands the hooks build and counts scheduled reads for ten
quiet, visible minutes (no invalidations):

| View | Off | On | Change |
| --- | --- | --- | --- |
| Running native view | 1,200 | 600 | −50 % |
| Idle qualified native view | 42 | 42 | 0 |
| Files panel, watched worktree | 120 | 22 | −82 % |
| Files panel, unwatched target | 120 | 60 | −50 % |
| Running reviewer tab | 150 | 22 | −85 % |

Each Files panel read is a list and (on All files) a tree request. These are
request counts; the live run of 2026-11-11 above measured bytes and requests
in real browsers.

## Running the probe through Tailscale Serve

Run on 2026-11-01; the results are under [Measurements](#measurements). Repeat it when Tailscale
or the gateway's stream handling changes. It adds a Serve handler to a tailnet
node, so never run it on a machine whose Tailscale setup must not change. It
uses a synthetic gateway only, so no real data, token or provider is involved.
It takes about ten minutes.

Use a node that is not serving production, and a second tailnet device as the
client. Tailscale Serve needs HTTPS enabled for the tailnet; if `tailscale serve`
asks for that, it is an administrator's decision. In the commands, `PROBE` is
`mise exec -- bun apps/backend/scripts/sse-route-probe.ts`, run from a checkout
of this branch or later.

On the server node:

1. Record `tailscale version`, and check that `tailscale serve status` shows
   nothing on port 8443. Stop if it does.
2. Start the gateway Serve will proxy, in its own terminal. Serve only proxies
   to the local machine, so this one stays on loopback:
   `PROBE serve --port 34990`
3. Start the control, in another terminal, on the tailnet address:
   `PROBE serve --bind "$(tailscale ip -4)" --port 34991`
4. Each prints a `url` and a `tokenFile`. If a port was taken, the gateway moved
   on to another, so use the port in `url` below. Copy both token files to the
   client, for example to `serve.token` and `direct.token`, and keep them private.
5. Publish the first gateway:
   `tailscale serve --bg --yes --https=8443 http://127.0.0.1:34990`

On the client, with `SERVE=https://<node>.<tailnet>.ts.net:8443` and
`DIRECT=http://<tailscale-ip>:34991`. Each run takes about 90 seconds and exits 0
when `incremental` is true:

```bash
PROBE measure --url "$SERVE"  --token-file serve.token  --label serve-gzip-h2 --http2 --out serve-gzip-h2.json
PROBE measure --url "$SERVE"  --token-file serve.token  --label serve-gzip-h1 --out serve-gzip-h1.json
PROBE measure --url "$DIRECT" --token-file direct.token --label direct-gzip   --out direct-gzip.json
PROBE measure --url "$SERVE"  --token-file serve.token  --label serve-identity --accept-encoding identity --out serve-identity.json
PROBE measure --url "$SERVE"  --token-file serve.token  --label serve-reconnect --reconnect-after 10 --out serve-reconnect.json
```

Then clean up on the server node. Do not use `tailscale serve reset`, which
removes every handler on the node:

1. `tailscale serve --yes --https=8443 off`
2. Check `tailscale serve status`, then press Ctrl+C in both `serve` terminals.

Reading the results:

- **Serve does not hold frames** if `serve-gzip-h2` and `serve-gzip-h1` have
  `heldTicks: 0` and `missing: 0`, and their delay is close to `direct-gzip`'s.
  A run over a bad link can show held ticks on the control too, which is the
  link rather than Serve.
- **Serve does not re-encode** if they have `contentEncoding: "gzip"` and
  `bytesMatch: true`.
- **Idle survives** if the last tick arrives (`missing: 0`) after the 60 s gap,
  with `keepalives` of at least 2.
- `serve-reconnect` should show `reconnects: 1`, `missing: 0`, `duplicates: 0`
  and `streamingActiveAfterClose: 0`. A tick missed during the gap can count as
  held, because it really was late.

Record the Tailscale version and the five results under
[Measurements](#measurements). If Serve holds or changes frames, the matrix must
label that route as measuring Serve, and the `on` default (decided on the
2026-11-01 probe) has a new question to answer.

## If the WebSocket becomes the terminal transport

Only if a later decision makes the WebSocket the remote terminal transport
does it need message compression, because its frames are uncompressed. Under
Bun the backend's `ws` import resolves to Bun's built-in module, not the
pinned `ws` package, so anything here must be measured under Bun. A loopback
probe on Bun 1.4.4 (2026-11-05) through `handleUpgrade` with
`perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true,
clientNoContextTakeover: true, serverMaxWindowBits: 10, concurrencyLimit: 2 }`
negotiated the extension, left 64 B and 900 B messages uncompressed, cut
16 KiB of coloured test output to 1,650 B and grew 64 KiB of random bytes by
1 %, for roughly 30 ms of extra send CPU per MB. Whether Bun honours
`concurrencyLimit` or bounds per-socket zlib memory was not shown. The work
would then need:

1. `perMessageDeflate` on `TerminalWebSocketGateway` with a threshold of about
   1 KiB, no context takeover in either direction and a small window.
2. Compressor memory bounded by bytes and count across all sockets: a heap
   measurement at the socket limit under Bun, or a process-wide ceiling with
   an uncompressed fallback as SSE has.
3. Compression off on the control listener and when the gateway mode is `off`.
4. Frame sizes and CPU measured with `remote-bandwidth-baseline.ts` (its raw
   client must offer the extension) and the live spec.
5. Tests for negotiation, the threshold, a client that offers no extension,
   backpressure and the 256 KiB flush watermark counted on uncompressed
   bytes, and the gauges returning to zero after close, rotation and stop.
6. A compatibility note in [remote-gateway.md](../architecture/remote-gateway.md):
   a client or proxy that does not offer the extension keeps uncompressed
   frames.
