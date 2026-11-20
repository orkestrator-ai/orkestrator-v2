# Terminal key-to-echo latency under load

How responsive an interactive shell stays while other terminals, agents and
clients are busy: the loopback benchmark and the real-browser measurement,
what they found, and what was changed. Follow-up work is in
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
| Observers | Client processes holding the main stream and a stream of every terminal, reading the changed transcript rows (`get_native_agent_live_update`) on every activity event, as an open agent tab does. They also request one terminal state snapshot at a time, at most once per second per observer. |

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
shell's does. Each write carries a short printable identifier, allowing a
late echo to be discarded after a timeout. Both parser variants receive and
decode the same terminal streams. With `--client-parse on` (the default), the
client also feeds the decoded output into headless xterm. The backend starts
its measurement window after warm-up and acknowledges readiness before the
first measured write. Unexpected SSE disconnects fail the level.

It reports, per level:

- **key-to-echo**: from sending the key to its echo arriving at the client;
- **backend echo**: from `terminal_write` arriving to the echo being emitted,
  the backend's share;
- **event-loop lag** in the backend process (a 10 ms timer chain; Bun's
  `monitorEventLoopDelay` misses synchronous work, see
  `scripts/efficiency/resources.ts`);
- **checkpoints per second**, **snapshot reads per second** and **snapshot read
  latency** during the measurement window, plus the duration of each
  `SerializeAddon.serialize` call;
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

**Historical attribution.** One run per variant at the heavy level. The
original parser toggle also removed load-terminal subscriptions, so those
rows measure the combined cost of delivery, decoding and parsing.

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

The client-side variant measured the combined subscription and parsing cost.
Renderer-side measurement is follow-up work (8312 task 2).

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
   slices of at most 8,192 UTF-16 code units, one slice in flight per terminal
   and at most 32,768 code units across all of them, taken in turn, with the next slices issued from
   `setImmediate` after the loop has polled for I/O. Nothing is dropped and
   per-terminal order is kept; a write resolves once all of its slices are
   parsed, as before.
3. **Checkpoint progress** (`TerminalHistory.scheduleCheckpoint`). Every
   eligible boundary is serialized as the parser reaches it. A newer valid
   screen can replace one still waiting for disk I/O. This preserves partial
   crash recovery during a sustained backlog and when a later boundary ends
   inside an oversized unfinished escape sequence.
4. **Hidden tabs parse in idle time** (`apps/web/src/lib/terminal-background-writes.ts`,
   used by `PersistentTerminal` through `use-hidden-terminal-writes.ts`; 8312
   task 2). A hidden terminal tab stays subscribed and receives every byte, as
   decided on 2026-10-27, but its writes wait in a FIFO and reach xterm.js one
   32 KiB slice at a time from `requestIdleCallback` (200 ms timeout), with one
   slice in flight across the page. Input and rendering run before idle
   callbacks, so the shown tab's echo waits behind at most one slice's parse
   instead of every hidden tab's 12 ms parse tasks. Reveal flushes the queue.
   Replacement replay and history capture wait for earlier bytes to finish
   parsing. A pane move keeps the live xterm buffer. A gate above 4 MiB or
   4,096 writes flushes into xterm.js. Separately, a WebSocket channel above
   4 MiB or 1,024 pending frames resubscribes for snapshot recovery and only
   acknowledges revisions that completed parsing. The local-storage key `orkestrator-terminal-background-writes` set
   to `off` before a terminal mounts writes straight through, as before; it
   exists for the measurement below.

## Historical before and after

Medians of three full-ladder runs each on the same host with matching options.
These runs predate the corrected workload, measurement boundaries and
checkpoint durability change. The values describe the original experiment.

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

## In a real browser

`e2e/agent-testing/terminal-echo-latency-live.spec.ts` (8312 task 3) types into
a real terminal tab in headless Chromium against an isolated `dev:test`
profile and times each echo in the page with `performance.now()`: from the
keydown event's own timestamp, so time the key waited behind other
main-thread work counts, to the mutation of xterm.js's rows that shows the
echo (xterm.js's DOM renderer updates rows in an animation frame, so this is
the frame that paints it). The typing terminal runs `cat` in raw mode, as the
loopback benchmark's does. After 10 warm-up keys it types 200 (150 in the A/B
run), each 30 ms after the previous echo. The page also records long tasks and
animation-frame gaps. The backend's own event-loop monitor is read from
`/__orkestrator/metrics` around each run. It counts ticks at least 100 ms late.
The benchmark reports unavailable counters separately from a measured zero.

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  mise run dev:test --profile echo8312 --fixture --no-agent-credentials --no-host-seed \
  --headless --agent-platforms claude
ORKESTRATOR_AGENT_TEST_PROFILE=echo8312 ORKESTRATOR_AGENT_TEST_LIVE_TERMINAL_ECHO=1 \
  ORKESTRATOR_AGENT_TEST_FAKE_MODEL_PORT=43312 \
  mise run test:logged -- --name terminal-echo -- bunx playwright test \
  --config e2e/agent-testing/playwright.browser.config.ts terminal-echo-latency-live.spec.ts
mise run dev:stop --profile echo8312
mise run dev:reset --profile echo8312
```

`ORKESTRATOR_AGENT_TEST_ECHO_VARIANTS`, `_ROUNDS`, `_KEYS`, `_BUILD`, `_TOOL`,
`_AGENTS` and `_STREAM` select the variants, rounds, keys, load terminals,
agents and streamed answer length. Evidence (numbers only) is written as
`evidence-terminal-echo.json` in the test's Playwright artifact directory.
A cell requires all measured keystrokes, output from each requested producer,
and fake-model streams covering the typing window. The reveal case checks all
600 numbered lines in xterm's retained buffer and checks the visible screen
on reveal, WebSocket reconnect, and reload.

The tables below record the original harness runs. The original probe could
wait five seconds after it had already recorded an echo. It also accepted
cells without checking the requested load, and an empty metrics response
could look like zero stalls. The full comparison needs to be repeated with
the corrected harness before these figures inform a backend-worker decision.

**Load shape.** The loopback benchmark's `busy` level, minus observers:
three fixture terminals running `producer.ts build` at 256 KiB/s, two running
`producer.ts tool` (2 MiB every 1.5 s), and four native Claude agents (the
real CLI and bridge) each streaming a 1,600-line answer (2,000 in the A/B run)
from the loopback model in `fake-anthropic-model.ts`, one delta every 25 ms.
Nothing is billed. The heavy check uses six build and three tool terminals
with the same four agents.

**Variants.** Each runs in its own fixture environment, so only its parts
mount in the page:

| Variant | The page shows | The page receives and parses |
| --- | --- | --- |
| idle | the typing terminal | nothing else; no load runs |
| backend-only | the typing terminal | nothing else; the load runs in terminals and agents of other environments |
| agent-visible | the typing terminal beside a streaming agent | that agent's transcript |
| hidden-tabs | as agent-visible, with the five load terminals as hidden tabs beside the typing tab | the transcript and all five load terminals |
| hidden-tabs-direct | hidden-tabs with the measurement switch off (writes straight into xterm.js, as before this change) | the same |

Measured on 2026-11-20 on `beelink2` (Linux x64, 16 threads, Bun 1.4.4,
the `dev:test` Vite renderer, headless Chromium), against `main` at
`0b778d995` plus this change. Figures are the medians of the per-round
percentiles, in ms; variants rotate between rounds. No key timed out.

**Before the change** (three rounds; load average fell from 25 to 3 during
the run):

| Variant | p50 | p95 | p99 | Long tasks per run, ms |
| --- | --- | --- | --- | --- |
| idle | 37.0 | 38.3 | 40.9 | 0 |
| backend-only | 27.6 | 40.1 | 44.1 | 0 |
| agent-visible | 34.5 | 81.6 | 97.4 | 1,165 |
| hidden-tabs (writes straight into xterm.js) | 39.3 | 79.7 | 109.2 | 1,201 |

**Idle with no agents anywhere** (four rounds, load average about 1): p50
25.1, p95 26.9, p99 33.9, every round's p50 between 24.7 and 25.3. Up to one
16.7 ms frame of it is the wait for the animation frame that paints the echo.

**Heavy terminal load, backend only** (six build and three tool terminals,
four agents; three rounds, load average about 1):

| Variant | p50 | p95 | p99 |
| --- | --- | --- | --- |
| idle | 32.0 | 35.3 | 36.2 |
| backend-only | 27.0 | 31.4 | 42.3 |

**Hidden-tab writes, A/B** (three rounds of 150 keys, 2,000-line answers so
every agent streamed throughout, load average about 1):

| Variant | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| agent-visible | 36.6 | 83.6 | 120.4 | 127.5 |
| hidden-tabs (idle-time writes) | 35.4 | 64.2 | 91.3 | 101.7 |
| hidden-tabs-direct | 35.5 | 80.4 | 100.7 | 101.5 |

What the original runs suggested:

- **The backend-only and idle timings were close.** At the busy level they
  were similar, and at the heavy terminal level the backend-only p99 was
  about 6 ms slower. The backend-worker task (8312 task 1) stays open pending
  a verified comparison.
- **The renderer's largest cost is a visible streaming agent**, not terminals:
  showing one beside the typing terminal adds about 40 ms at p95 and 50 ms at
  p99, with about a second of long tasks per run.
- **Hidden tabs' parsing is a smaller share**, about 10 to 15 ms at p99 before
  the change (hidden-tabs against agent-visible in the first run;
  hidden-tabs-direct against hidden-tabs in the A/B). Idle-time writes took
  16 ms off p95 and 9 ms off p99 against direct writes in the same run. The
  A/B's agent-visible row being higher than both shows the run-to-run spread
  (about 20 ms at p95 and p99 under load): read the A/B as the difference
  between its two hidden-tabs rows.
- **Echo slows as agents' transcripts grow.** In every loaded run the same
  variant's p50 rose round by round (idle 25, 37, 45 ms in the first run) while
  the idle-only run, with no agent turns, stayed flat. Each round adds four
  long agent turns; what grows with them is not yet known (8312 task 4).

## Limitations

- The loopback benchmark has no real browser or renderer: its typing client's
  headless parse stands in for the renderer's xterm.js parse, but not for its
  rendering. The real-browser figures above cover the renderer, on one host,
  over loopback, with the development (Vite) renderer and headless Chromium,
  whose frame timing and rendering differ from a desktop window's.
- In the loopback benchmark agents are simulated: their transcript reads
  follow the live-update shape, not the real projection's cost. The browser
  run uses the real Claude CLI and bridge on a loopback model, whose answers
  are plain streamed text with no tool calls.
- Observers count desync notices and exercise snapshot reads under load. They do
  not reconstruct a renderer or reapply the returned screen.
- Variation between runs is a few milliseconds at p95 and up to about 15 ms
  at p99 under heavy load; compare medians of several runs.
