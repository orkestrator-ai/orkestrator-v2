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

1. **Code-unit scanners** (`apps/backend/src/core/terminals/history-scanners.ts`).
   Both scanners now read UTF-16 code units, jump over plain text with one
   regular-expression search and copy unchanged runs with one `slice`. They
   take state decisions on whole code points as before;
   `terminals/history-scanners.test.ts` keeps the per-character originals
   verbatim and checks the new ones against them on 800 generated inputs cut
   at random points.
2. **Metered headless parsing** (`apps/backend/src/core/terminals/parse-scheduler.ts`).
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
run), each 30 ms after the previous echo plus a spread of up to one 60 Hz
frame (a golden-ratio sequence), so keys land at every phase of the page's
frame clock as a person's do (8312 task 4, below). The page also records long
tasks and animation-frame gaps, and splits each key with resource timing: its
own command request's send time after the keydown (`sent`), the wait before
Chromium sends it (`queued`), the browser-observed request-to-first-byte time
(`server`, calculated as `responseStart - requestStart`) and the request's
duration. The backend's own event-loop monitor is read from
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
`ORKESTRATOR_AGENT_TEST_ECHO_CPU_PROFILE=1` adds a Chromium CPU profile of
the measured page per cell (`page-<variant>-r<round>.cpuprofile`), and
`ORKESTRATOR_AGENT_TEST_ECHO_TRACE=1` a performance trace
(`trace-<variant>-r<round>.json`, about 60 MB per 200-key cell).
Trace mode defaults to one idle round. Explicit variant and round selections
can cover up to three cells, with at most 200 measured keys per cell. Each
traced cell has a 64 MiB budget shared with its optional CPU profile. The
remaining artifact space covers the report and other evidence. If a capture
exceeds its per-cell budget, lower `ORKESTRATOR_AGENT_TEST_ECHO_KEYS`.

Profiling and tracing slow the page. Compare their latencies with other runs
using the same capture settings. Each cell records the runner's monotonic clock
(`monotonicStartUs`) so a `NODE_OPTIONS=--cpu-prof` profile of the Playwright
worker can be cut per cell. `keyPhaseMs` summarizes keydown offsets from the
preceding animation frame. `keyRequestMs` measures terminal writes for the
typing session. `keyRequestCounts` reports matched writes, missing writes,
ambiguous writes and missing resource timings. The probe allows up to two
seconds after measurement and profile export for pending timing entries.

A cell requires all measured keystrokes to echo, each requested terminal
producer's output revision to advance in the same generation between the
snapshots bracketing typing, and fake-model streams covering the typing
window through the final echo.
`profileExportMs` reports export time separately. The reveal case checks all
600 numbered lines in xterm's retained buffer and checks the visible screen
on reveal, WebSocket reconnect, and reload.

The tables below record the original harness runs. The original probe could
wait five seconds after it had already recorded an echo. It also accepted
cells without checking the requested load, and an empty metrics response
could look like zero stalls. The backend-worker decision rests on the
corrected runs instead: the busy level in the transcript-growth section and
the heavy level in [its own section](#heavy-load-backend-only-with-the-corrected-harness-8312-task-1).

A review follow-up ran one round at the original busy load with the corrected
probe and load checks. All five cells recorded 200 measured keys with no
timeouts. The backend monitor advanced in every cell and recorded zero ticks
at least 100 ms late. Idle p95/p99 were 27.0/28.3 ms and backend-only p95/p99
were 32.9/37.4 ms. This run verifies that the harness can measure the busy
shape. The multi-round busy comparison (2026-11-22) and the heavy
backend-only comparison (2026-11-26) were repeated afterwards; both are below.

**Load shape.** The loopback benchmark's `busy` level, minus observers:
three fixture terminals running `producer.ts build` at 256 KiB/s, two running
`producer.ts tool` (2 MiB every 1.5 s), and four native Claude agents (the
real CLI and bridge) each streaming a 1,600-line answer (2,000 in the A/B run)
from the loopback model in `fake-anthropic-model.ts`, one delta every 25 ms.
Nothing is billed. The heavy check uses six build and three tool terminals
with the same four agents.

**Variants.** Idle and backend-only share the terminal-only environment.
Agent-visible uses a separate environment, and the two hidden-tab variants
share another.

| Variant | The page shows | The page receives and parses |
| --- | --- | --- |
| idle | the typing terminal | nothing else; no load runs |
| backend-only | the typing terminal | only typing-terminal output. Load terminals have unmounted session keys in the typing environment, and agents run in other environments. |
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
  about 6 ms slower. The corrected harness found no difference at either
  level (below), so the backend worker (8312 task 1) was not built.
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
- **Echo seemed to slow as agents' transcripts grew.** In every loaded run
  the same variant's p50 rose round by round (idle 25, 37, 45 ms in the first
  run) while the idle-only run, with no agent turns, stayed flat. The cause
  was the harness, not the transcripts: see below (8312 task 4). These runs
  typed at a fixed cadence, so their p50s, including the comparisons between
  variants above, carry the same frame-phase bias; their p95 and p99 are less
  affected.

### Why the echo seemed to slow as transcripts grew (8312 task 4)

Investigated on 2026-11-22 on `beelink` (Linux x64, 16 threads), against
`main` at `dd1391427`, with `idle,backend-only` over three rounds at the busy
load shape and a credential-free profile. Figures are per-round p50s in ms;
no key timed out in any cell.

**What grows.** Neither the backend nor the page:

- *Backend.* A Bun CPU profile of the backend across the run, cut per cell,
  sampled at the same rate in every round (about 15, 10 and 10 samples a
  second in the idle cells, 91, 88 and 87 in the backend-only cells, at a
  3 ms interval). Native-agent and activity code stayed a few percent of
  that. The keystroke request's server time stayed at 0.6 ms (resource
  timing) and the event-loop monitor recorded no late ticks.
- *Page.* Chromium CPU profiles of the measured page per cell: idle 92 to 94%
  of every idle cell and 87 to 89% of every backend-only cell, no long tasks.
  A performance trace showed the main thread busy for about 5 ms of each
  key's wait, in every round.
- *The Playwright worker.* Its CPU (from `/proc`) rose from 27% in the first
  idle cell to about 40% in the later ones. A `NODE_OPTIONS=--cpu-prof`
  profile of it put the growth in Playwright's own step bookkeeping:
  `_addStep` and `_findLastPredefinedStep` (which walks the case's whole step
  tree on every API call) and `onApiCallBegin` took 22% of the worker in the
  first idle cell and 34% in the third. Every Playwright API call records a
  step, including each `route.fallback()` and `route.fulfill()` of the
  spec's module route. Each loaded round reloads the app in four driver
  pages, and every module of each load is a fulfilled route, so loaded
  rounds add steps by the thousand while idle rounds add a few hundred. That
  would explain why the idle-only run stayed flat; the steps were not
  counted.

**How the worker reached the echo.** Two ways:

1. *The keystroke's request waited for it.* The module route
   (`fetchModulesOutsideChromium` in `browser-test.ts`) matched every loopback
   URL, so Chromium held each command request until the worker's handler
   answered `route.fallback()`. Across three rounds, that wait
   (`queued`) grew from 4.4 to 7.1 ms in idle and from 5.9 to 9.0 ms in
   backend-only.
2. *It moved the keys' frame phase.* The spec typed each key 30 ms after the
   previous echo, plus its own Playwright round trips, so every key landed at
   about the same point in the page's 16.7 ms frame. Chromium defers ordinary
   tasks after a discrete input event until the next frame, so the browser
   client's 8 ms typing timer (`TERMINAL_HTTP_INPUT_BATCH_DELAY_MS`) fired on
   time only when a frame fell inside those 8 ms. Traces of the backend-only
   cells showed it: in round 1, 155 of 200 keys landed 12 to 16 ms after a
   frame and their timers fired at 8.1 ms (median); in round 2, 96 landed 0
   to 4 ms after a frame and their timers fired at 15.4 ms, just behind the
   next frame, while the main thread was busy for about 5 ms of the wait. As
   the worker slowed, the phase drifted and the median flipped from the
   one-frame cluster to the two-frame one.

**What changed (harness only).**

- The module route's pattern is `MODULE_ROUTE_URL`, which leaves the gateway's
  API (`/__orkestrator/…`, never a module) out. It is a regular expression,
  so Playwright matches it in its own server and continues those requests
  without calling the case's handler or recording a step.
- Each key's gap adds a golden-ratio spread of up to one 60 Hz frame
  (`keyPhaseOffsetMs`), so keys land at every phase of the frame, as a
  person's do. Cells now also report the mean.

| Run | Variant | Round 1 | Round 2 | Round 3 | Request `queued` p50, r1 → r3 |
| --- | --- | --- | --- | --- | --- |
| Before (fixed cadence) | idle | 24.2 | 32.4 | 32.5 | |
| Before (fixed cadence) | backend-only | 21.2 | 32.8 | 28.5 | |
| Before, repeat with request timing | idle | 24.4 | 32.6 | 33.3 | 4.4 → 7.1 |
| Before, repeat with request timing | backend-only | 21.5 | 32.8 | 28.4 | 5.9 → 9.0 |
| After | idle | 27.4 (mean 27.2) | 27.5 (27.1) | 27.5 (27.3) | 1.6 → 1.7 |
| After | backend-only | 26.7 (27.1) | 26.8 (27.3) | 26.3 (26.5) | 1.5 → 1.5 |

p95 stayed between 32 and 36 ms in every cell of both. A third run of the
final code with the backend and page profilers attached was flat as well
(means 26.7 to 27.4 ms).

**Typing timer A/B.** The same harness with the browser's typing timer at 0
(a key sent at once, later keys coalescing while it is in flight, as the
Electron relay already does) sent each keystroke 0.5 ms after its keydown
instead of 10.3 ms, and echoed no sooner: per-round means 27.4 to 27.7 ms
against 26.5 to 27.3 ms. The echo itself waits behind the same deferred
frame, so in headless Chromium at 60 Hz the timer costs no echo time once
keys are not phase-locked. The timer was left at 8 ms.

### Heavy load, backend only, with the corrected harness (8312 task 1)

Measured on 2026-11-26 on `beelink2` (Linux x64, 16 threads, load average
about 1 to 2), against `main` at `8950e12e2`, with a credential-free profile:
six build and three tool terminals with unmounted session keys in the typing
environment, plus four fake-model agents in other environments. Two runs
compared backend-only with idle over three rounds each, using opposite
starting orders and 200 measured keys per cell, with no timeouts. The
terminal producer checks confirmed output revision advancement in the same
generation between snapshots bracketing typing. The agent stream checks
confirmed coverage through the final echo.

Start the [isolated profile above](#in-a-real-browser) with `echo8312h`
in place of `echo8312`. In a separate shell, wait for
`mise run dev:status --profile echo8312h --json` to report `ready`, then run
the commands below in order. Save each run's `evidence-terminal-echo.json`
before another invocation overwrites it. After both runs, stop and reset
`echo8312h` using the cleanup commands from the same setup.

```bash
run_heavy_echo() {
  local variant_order=$1
  ORKESTRATOR_AGENT_TEST_PROFILE=echo8312h ORKESTRATOR_AGENT_TEST_LIVE_TERMINAL_ECHO=1 \
    ORKESTRATOR_AGENT_TEST_FAKE_MODEL_PORT=43312 \
    ORKESTRATOR_AGENT_TEST_ECHO_VARIANTS="$variant_order" ORKESTRATOR_AGENT_TEST_ECHO_ROUNDS=3 \
    ORKESTRATOR_AGENT_TEST_ECHO_KEYS=200 ORKESTRATOR_AGENT_TEST_ECHO_BUILD=6 \
    ORKESTRATOR_AGENT_TEST_ECHO_TOOL=3 ORKESTRATOR_AGENT_TEST_ECHO_AGENTS=4 \
    mise run test:logged -- --name "terminal-echo-heavy-${variant_order%%,*}-first" -- bunx playwright test \
    --config e2e/agent-testing/playwright.browser.config.ts terminal-echo-latency-live.spec.ts
}

run_heavy_echo idle,backend-only
# Save the first evidence file before starting the second run.
run_heavy_echo backend-only,idle
```

The rule for a felt backend load was recorded before the first heavy cell:
felt if the median of backend-only's per-round p95s (or p99s) is more than
5 ms above idle's, and backend-only is more than 5 ms worse than the same
round's idle on that percentile in at least two of three rounds; or if the
backend's monitor records any tick at least 100 ms late in a backend-only
cell. The reasons for its thresholds are in
[8312](../todo/cross-cutting/8312-terminal-echo-under-load-follow-ups.md).

Each row lists rounds 1 through 3 in order.

| Run | Variant | Echo mean, r1 / r2 / r3 ms | Echo p95, ms | Echo p99, ms | Late ticks (≥100 ms) | Request-to-first-byte p95, ms | Request-to-first-byte p99, ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | idle | 27.2 / 27.2 / 27.1 | 34.8 / 34.6 / 34.4 | 35.8 / 37.3 / 35.3 | 0 / 0 / 0 | 0.9 / 0.9 / 0.8 | 4.1 / 1.0 / 0.9 |
| 1 | backend-only | 26.6 / 26.6 / 26.9 | 34.2 / 34.4 / 34.1 | 35.1 / 35.5 / 34.9 | 0 / 0 / 0 | 1.1 / 1.1 / 1.3 | 1.8 / 2.8 / 3.5 |
| 2 | idle | 27.1 / 27.0 / 27.4 | 34.6 / 34.0 / 34.3 | 35.4 / 34.5 / 35.0 | 0 / 0 / 0 | 0.9 / 0.9 / 0.9 | 1.0 / 1.0 / 1.0 |
| 2 | backend-only | 26.8 / 27.0 / 26.9 | 34.3 / 34.5 / 34.7 | 35.4 / 35.4 / 35.3 | 0 / 0 / 0 | 1.3 / 1.4 / 1.6 | 4.0 / 3.1 / 3.8 |

Backend-only was never more than 1 ms worse than idle at p95 or p99 in any
round, and no cell recorded a late tick or stall, so the load did not meet
the felt rule. Browser resource timing measured keystroke request-to-first-byte
(`responseStart - requestStart`) p99 at 1.8 to 4.0 ms in backend-only cells.
Five of six idle cells measured 0.9 to 1.0 ms, and the first idle cell
measured 4.1 ms. The elapsed time includes the request and response transit
as well as any backend queueing and execution. Frame quantization may explain
why these timing differences produced little change in measured echo latency.
8312 task 1 keeps the worker design and the measured threshold for building it.

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
  at p99 under heavy load in the loopback benchmark; compare medians of
  several runs. The corrected browser spec varies less (under 1 ms at p95
  and about 3 ms at p99 between identical idle cells).
- The heavy browser comparison covers one 16-thread host, loopback, and nine
  load terminals. A slower host, a remote client or more terminals have not
  been measured.
- Echo latency is frame-quantised: an echo paints one or two frames after its
  key, depending on the key's phase in the frame. A median of such a
  distribution moves by a whole cluster when the phase shifts, which is why
  keys are spread over the frame and cells report the mean.
- The Playwright worker's cost per API call grows with the steps a case has
  recorded. Keep it out of the measured path: anything the page waits on
  during a measured key should not need the worker.
