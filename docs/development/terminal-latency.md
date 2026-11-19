# Terminal key-to-echo latency under load

How responsive an interactive shell stays while other terminals, agents and
clients are busy: the benchmark that measures it, what it found, and what was
changed. Follow-up work is in
[8312](../todo/cross-cutting/8312-terminal-echo-under-load-follow-ups.md).

The idea comes from Paseo's terminal performance notes and typing-latency
benchmark (`docs/terminal-performance.md` and
`scripts/benchmark-terminal-latency.ts` in `getpaseo/paseo` at `0feaf0d`),
which measure typing latency under increasing agent load. Paseo moved terminal
parsing into a worker and still documents contention on its shared loop, so
the measurement came first here.

## The benchmark

```bash
mise exec -- bun apps/backend/scripts/terminal-latency.ts            # the default ladder, as a table
mise exec -- bun apps/backend/scripts/terminal-latency.ts --json     # full report
mise exec -- bun apps/backend/scripts/terminal-latency.ts --only heavy --history off
mise exec -- bun --cpu-prof-md --cpu-prof-dir output/terminal-latency \
  apps/backend/scripts/terminal-latency.ts --only heavy --client-parse off
```

`--help` lists every option. A full ladder takes about three minutes.

The benchmark process plays the backend with real parts: the gateway
(`OrkestratorGateway`: SSE fan-out, compression, the invoke route), the
`TerminalRuntime` with its replay buffers and durable `TerminalHistory`
(headless xterm, checkpoints, archive) and real PTYs from `spawnPty`,
coalescing included. Clients run as separate processes
(`apps/backend/scripts/terminal-latency/client.ts`), as a renderer does, so
the backend's event loop cannot hold their clocks. They use the default
browser transport: terminal output on a filtered `/__orkestrator/events`
stream and keystrokes as `terminal_write` through `/__orkestrator/invoke`.

Each level adds, all at once:

| Load | What it is |
| --- | --- |
| Build terminals | A PTY running `terminal-latency/producer.ts build`: coloured build lines and progress bars at 256 KiB/s each. |
| Tool terminals | A PTY dumping a 2 MiB block (diff and JSON lines) every 1.5 s, staggered. |
| Agents | A transcript row every 250 ms (8 KiB of tool output, every tenth 128 KiB), announced with the real `native-agent-session-activity` event. |
| Observers | Client processes holding the main stream and a stream of every terminal, reading the changed transcript rows (`get_native_agent_live_update`) on every activity event, as an open agent tab does. |

| Level | Build | Tool | Agents | Observers |
| --- | --- | --- | --- | --- |
| idle | 0 | 0 | 0 | 0 |
| light | 1 | 1 | 2 | 1 |
| busy | 3 | 2 | 4 | 2 |
| heavy | 6 | 3 | 8 | 3 |

`--level name:build,tool,agents,observers` replaces the ladder.

A typing client then types 200 keys (after 10 warm-up keys), one at a time
with 30 ms between an echo and the next key, into an interactive terminal
running `cat` in raw mode, so the echo comes from a user-space process as a
shell's does. With `--client-parse on` (the default) it also subscribes to the
level's load terminals and feeds every terminal it receives into a headless
xterm on its own thread, as the renderer parses each mounted terminal tab.

It reports, per level:

- **key-to-echo**: from sending the key to its echo arriving at the client;
- **backend echo**: from `terminal_write` arriving to the echo being emitted,
  the backend's share;
- **event-loop lag** in the backend process (a 10 ms timer chain; Bun's
  `monitorEventLoopDelay` misses synchronous work, see
  `scripts/efficiency/resources.ts`);
- **serializations per second** (checkpoints and snapshots, through the
  history's `serializeHook`) and each `SerializeAddon.serialize` call's
  duration;
- terminal throughput, transcript reads per second, desyncs, peak RSS and heap
  of the backend, and the typing client's RSS.

Every level uses its own temporary directory, an ephemeral loopback port and
a random credential that is never printed. Reports are aggregates only, never
terminal content.

`scripts/benchmark-terminal-history.ts` remains the history-only benchmark
(ingest, snapshot and page cost for 1, 10 and 50 terminals, with no clients).

## What it found

Measured on 2026-11-19 on a 12-thread Linux host (Bun 1.4.4, load average
under 1 before each run), against `main` at `0007f0e66`.

**Attribution.** One run per variant at the heavy level:

| Variant | Key-to-echo p95 / p99 ms | Backend echo p95 ms | Loop lag p99 ms | Peak RSS MiB |
| --- | --- | --- | --- | --- |
| As on `main` | 142 / 228 | 45 | 47 | 596 |
| Durable history off | 8.6 / 19.6 | 0.7 | 6.6 | 325 |
| Typing client not parsing | 97 / 118 | 43 | 48 | 528 |
| Both off | 1.7 / 8.3 | 0.6 | 5.9 | 298 |

Durable terminal history, all of it on the backend's event loop, was almost
the whole backend cost. A CPU profile of the heavy level split it:

- the history's own per-character JavaScript, about a third of samples:
  `trackParserCarry` (the checkpoint's unfinished escape sequence) and
  `sanitizeHistoryChunk` (the archive's plain text), which allocated a string
  and, in one of them, a closure per character;
- xterm's headless parser, about 25%, which parses each `write` in one
  uninterrupted run once its timer fires and keeps going for up to 12 ms, with
  every busy terminal's timer firing in the same timers phase;
- `SerializeAddon.serialize`, about 3% of samples, but 9 to 12 ms per full
  call, about five times a second.

Parsing in the typing client added the rest of the client-side figure; that
is the renderer's cost and is follow-up work (8312 task 2).

## What changed

1. **Code-unit scanners** (`apps/backend/src/core/terminal-history-scanners.ts`).
   Both scanners now read UTF-16 code units, jump over plain text with one
   regular-expression search and copy unchanged runs with one `slice`. They
   take state decisions on whole code points as before;
   `terminal-history-scanners.test.ts` keeps the per-character originals
   verbatim and checks the new ones against them on 800 generated inputs cut
   at random points.
2. **Metered headless parsing** (`apps/backend/src/core/terminal-parse-scheduler.ts`).
   Every write to a history's headless terminals goes through one scheduler:
   slices of at most 8 KiB, one slice in flight per terminal and at most
   32 KiB across all of them, taken in turn, with the next slices issued from
   `setImmediate` after the loop has polled for I/O. Nothing is dropped and
   per-terminal order is kept; a write resolves once all of its slices are
   parsed, as before.
3. **Coalesced checkpoints** (`TerminalHistory.scheduleCheckpoint`). Output
   faster than parsing queued one checkpoint per mebibyte behind the backlog,
   and all but the newest were overwritten as soon as the parser caught up.
   Only the newest queued checkpoint now serializes
   (`terminal-history-load.test.ts`).

## Before and after

Medians of three full-ladder runs each, same host and options:

| Level | Key-to-echo p95 ms | Key-to-echo p99 ms | Backend echo p95 / p99 ms | Loop lag p95 / p99 / max ms | Serializations/s | Peak RSS MiB |
| --- | --- | --- | --- | --- | --- | --- |
| idle, before | 2.1 | 2.5 | 0.6 / 0.7 | 0.6 / 1.3 / 3.3 | 0.3 | 188 |
| idle, after | 2.1 | 2.4 | 0.6 / 0.8 | 0.6 / 1.2 / 3.1 | 0.3 | 188 |
| light, before | 2.2 | 126 | 0.7 / 48 | 2.1 / 28 / 51 | 1.7 | 375 |
| light, after | 1.9 | 23 | 0.7 / 2.3 | 0.7 / 7.6 / 16 | 1.2 | 295 |
| busy, before | 67 | 142 | 21 / 56 | 14 / 40 / 56 | 3.4 | 458 |
| busy, after | 7.7 | 30 | 2.7 / 12 | 2.3 / 8.9 / 30 | 2.4 | 420 |
| heavy, before | 142 | 176 | 47 / 72 | 24 / 47 / 80 | 5.0 | 584 |
| heavy, after | 26 | 42 | 6.8 / 21 | 4.1 / 14 / 25 | 4.2 | 479 |

Terminal throughput was the same before and after (5.3 MiB/s at heavy); no
key timed out in any run. The median key-to-echo stayed under 1.6 ms at every
level. Desyncs at heavy (slow-consumer resyncs of terminal streams) fell from
232 to 88.

## Limitations

- One host, loopback only; no real browser or renderer. The typing client's
  headless parse stands in for the renderer's xterm.js parse, but not for its
  rendering.
- Agents are simulated: their transcript reads follow the live-update shape,
  not the real projection's cost.
- Desyncs are counted, not recovered: no client fetches a snapshot after one,
  so snapshot reads under load are not measured.
- Variation between runs is a few milliseconds at p95 and up to about 15 ms
  at p99 under heavy load; compare medians of several runs.
