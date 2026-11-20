# Terminal echo under load: follow-ups

## Task analysis

Analysed 2026-11-20 against main at `0b778d995` (first analysed 2026-11-19
at `0007f0e66`). From the terminal key-to-echo latency work
([terminal-latency.md](../../development/terminal-latency.md)), which measured
the backend's share, cut it, and left these follow-ups. The real-browser
measurement (task 3) and the hidden-tab change (task 2) are done; their
figures are in [terminal-latency.md](../../development/terminal-latency.md#in-a-real-browser).

### Tasks

1. **Move headless parsing and serialization off the backend's event loop**: Status: open.
2. **Measure and reduce the renderer's parsing of hidden terminal tabs**: Status: done.
3. **Check typing latency in a real browser on a loaded `dev:test` profile**: Status: done.
4. **Find why echo slows as agents' transcripts grow**: Status: open.

### 1. Move headless parsing and serialization off the backend's event loop

**Problem.** The original heavy-load run of `apps/backend/scripts/terminal-latency.ts`
reported backend echo p99 of about 21 ms and loop-lag p99 of about 14 ms
after the first optimization pass. Those figures predate the benchmark and
checkpoint corrections.
xterm's headless parser is now about half of the backend's CPU under that
load, and each full `SerializeAddon.serialize` call holds the loop 9 to 12 ms.

**Context.** `TerminalHistory` (`apps/backend/src/core/terminal-history.ts`)
owns a headless xterm and a `SerializeAddon` per terminal. Writes go through
`HeadlessParseScheduler` (`terminal-parse-scheduler.ts`); serialization is
synchronous in `serializedState`. The backend ships as a Bun bundle
(`apps/backend/scripts/build.ts`) inside Electron and the CLI package, and
the only backend worker today (`packages/protocol/src/node/essential-log-worker.ts`)
inlines its source with `eval: true` so no separate worker file has to be
packaged.

**Investigation.** Turning durable history off entirely gave heavy-level echo
p95 8.6 ms and loop-lag p99 6.6 ms in one loopback run, which bounds what a
worker could recover. The headless terminal and its serializer are touched
from about 20 places, nearly all inside `terminal-history.ts`, including the
synchronous `serializedState` used by checkpoints, snapshots and the
graceful-shutdown checkpoint.

On 2026-11-20 the real-browser run (task 3) measured the backend's share as
the page sees it: with the load running only on the backend (terminals and
agents in other environments, so the page parses none of it), key-to-echo was
p50/p95/p99 27.6/40.1/44.1 ms against 37.0/38.3/40.9 ms idle at the `busy`
shape, and 27.0/31.4/42.3 ms against 32.0/35.3/36.2 ms with six build and three
tool terminals. Those were historical runs. The original harness could
confuse unavailable event-loop counters with zero stalls and did not verify
that the requested load covered each measurement. The worker remains open
pending a comparison with the corrected harness.

**Decisions.**

- **Where the headless terminals run.**
  - **A worker per backend holding every session's terminal, behind an async interface (the design to build once a measurement shows the remaining stall is felt).**
    - Pros: parsing and serialization leave the loop entirely; uses a second core.
    - Cons: `serializedState` and its callers become async; the worker needs `@xterm/headless` at run time, which means either a separately bundled worker entry in the backend, Electron and CLI builds or an inlined bundle; restart and crash handling for the worker. The historical browser figures need a verified comparison before they can inform this choice.
  - **Keep the metered scheduler and lower its budgets.**
    - Pros: no packaging change.
    - Cons: the work stays on the loop; smaller turns only spread it out, and throughput falls when the loop is busy.
  - **Leave it until a measurement shows a felt stall (recommended).**
    - Pros: no async conversion or packaging risk for no measured gain; the browser spec reruns the check (`backend-only` against `idle`).
    - Cons: a heavier or different load (more terminals, a slower host, a remote client) may still feel it, and nobody has measured those.
- **Serialization cost alone.**
  - **Serialize at most once per checkpoint interval under sustained output (time-only trigger while the parser is behind).**
    - Pros: fewer 10 ms holds.
    - Cons: a crash loses up to the interval's screen state rather than up to a mebibyte of output; a durability change to agree first.
  - **Leave the trigger as it is (recommended until the worker decision).**
    - Pros: no durability change.
    - Cons: Serialization still runs synchronously at every eligible checkpoint boundary.

### 2. Measure and reduce the renderer's parsing of hidden terminal tabs

**Problem.** The original heavy-load benchmark reported key-to-echo p95 of
about 26 ms with load-terminal subscriptions and client parsing enabled, and
about 17 ms with those subscriptions and parsing disabled. Renderer-side
impact had not been measured.

**Context.** Hidden terminal tabs of the selected environment stay subscribed
and parse their output (decided 2026-10-27 in
[remote-bandwidth.md](../../development/remote-bandwidth.md), because a
detached tab would come back with less history).

**Investigation.** Done on 2026-11-20 with task 3's spec. Five busy load
terminals as hidden tabs beside the typing tab added about 10 to 15 ms at p99
on top of a visible streaming agent: 109.2 ms against 97.4 ms in the first run,
and 100.7 ms (direct writes) against 91.3 ms (idle-time writes) in an A/B run
of the same build. That is a smaller share than the visible agent's own
transcript (about 50 ms at p99), but a real one, and the recommended option
keeps the 2026-10-27 decision intact, so it was built: hidden tabs' writes
wait for idle callbacks and reach xterm.js one slice at a time
(`apps/web/src/lib/terminal-background-writes.ts`). In the A/B run it took p95
from 80.4 to 64.2 ms and p99 from 100.7 to 91.3 ms in the original harness.
Those figures are historical. Repeat the full comparison with the corrected
harness before relying on them. The reveal check inspects all 600 numbered
lines within configured scrollback, plus the current screen.

**Decisions.**

- **How to cut the renderer's share.**
  - **Batch hidden tabs' writes into xterm.js on idle callbacks, keeping the subscription (recommended; done).**
    - Pros: keeps the 2026-10-27 decision's exact history; typing tab's frames go first.
    - Cons: hidden tabs lag behind and catch up on reveal; a queue past its bound falls back to direct writes.
  - **Unsubscribe hidden tabs and restore them from the backend snapshot on reveal.**
    - Pros: no hidden parsing at all.
    - Cons: reverses the 2026-10-27 decision; the snapshot halves scrollback when it is large.

### 3. Check typing latency in a real browser on a loaded `dev:test` profile

**Problem.** Every figure so far was from the loopback benchmark with
headless clients. Whether typing feels responsive in the real renderer while
several agents and builds run had not been observed.

**Context.** An isolated `dev:test --fixture` profile with fixture
environments can run build commands in terminals and agents with a fake
model ([agent-testing.md](../../development/agent-testing.md)).

**Investigation.** Done on 2026-11-20:
`e2e/agent-testing/terminal-echo-latency-live.spec.ts` types into a terminal
tab in headless Chromium and times each echo in the page. Results and how to
run it: [terminal-latency.md](../../development/terminal-latency.md#in-a-real-browser).

**Decisions.**

- **How to load the profile.**
  - **Fixture terminals running `producer.ts` build and tool loads, plus agents on a fake model (recommended; done).**
    - Pros: repeatable; no provider credentials; same load shapes as the benchmark.
    - Cons: fake-model agents produce less transcript work than real ones.
  - **Real agents on real providers.**
    - Pros: real transcript shapes.
    - Cons: needs credentials and costs money; not repeatable.

### 4. Find why echo slows as agents' transcripts grow

**Problem.** In every loaded browser run, the same variant's key-to-echo p50
rose round by round, the idle variant included (25, 37 and 45 ms in the first
run), while an idle-only run with no agent turns stayed at 25 ms over four
rounds. Each loaded round adds one long streamed turn to each of four agents.
Something whose cost grows with transcript length slows typing even in an
environment that shows no agent.

**Context.** The idle variant's environment shows only the typing terminal;
the agents run in other environments and the driver pages that prompt them
leave for a blank page once their turns start. Candidates are the backend's
per-turn transcript work (projections, activity sweeps, persistence) and the
page's work for agents it does not show (sidebar activity, stores). Nothing
has been profiled yet.

**Investigation.** Not started. The spec reproduces it: run several rounds of
`idle,backend-only` and compare round 1 with round 3.

**Decisions.**

- **How to find it.**
  - **Profile the backend and the page across rounds with the browser spec (recommended).**
    - Pros: the spec already reproduces it on a fake model; a CPU profile of each side names the growing work.
    - Cons: needs a profile run per side.
  - **Measure with the loopback benchmark.**
    - Pros: quicker to run.
    - Cons: its agents are simulated and do not grow real transcripts, so it may not show the effect.

## Assumptions and decisions

### Task 3: hidden-tab parsing toggle

The renderer had no switch for hidden-tab parsing, so the spec measures it two
ways: by where the load terminals live (hidden tabs of the shown environment
against sessions of another environment, which the page never subscribes to),
and, after task 2, by the local-storage measurement switch
`orkestrator-terminal-background-writes=off`, which writes hidden tabs straight
into xterm.js as before. The switch lets both run back to back in one run.

### Task 3: timing points

Each latency runs from the keydown event's own timestamp to the mutation of
xterm.js's rows that shows the echo, so time a key waits behind other
main-thread work counts. Playwright's own round trips are outside it.

### Task 2: built on a smaller share than the visible agent

Hidden-tab parsing measured at about 10 to 15 ms at p99, a third or less of
the visible agent's cost. It was still built because the to-do's recommended
option is self-contained, keeps the 2026-10-27 subscription decision and its
exact history, and its A/B showed the gain.

### Task 2: order parser work at replay and capture boundaries

Replacement replay queues its reset behind earlier parser work and immediately
queues the replacement bytes after it. Cleanup captures history after the
parser reaches the same boundary and checks that the terminal and session
still own the result. Pane moves reuse the live buffer, so they avoid a
serialize-and-replay round trip. The WebSocket client caps the pending
application queue and recovers an overloaded channel through its snapshot
path. A revision is acknowledged after its parser callback.

### Task 3: verify each load cell before accepting its measurements

The benchmark requires a dedicated credential-free fixture profile, verifies
PTY delivery and producer revisions, and starts the fake-model streams
together after every driver reaches the hold. It verifies the idle and direct
renderer modes independently. These checks preserve the historical tables
while making clear which evidence a future backend-worker decision can use.

### Task 1: not built

The ticket conditions the worker on a measured backend stall. The original
runs compared idle and backend-only typing. Review found gaps in verification
of producer activity, stream duration and stall counters. Use the corrected
harness for the comparison before deciding whether a worker is warranted.

## Constraints and rationale

- Nothing may drop terminal output to save latency: history order and the
  snapshot's exact screen are what reconnect recovery depends on.
- Metrics and reports stay content-free.

## Related

- [terminal-latency.md](../../development/terminal-latency.md)
- [0741-backend-responsiveness-under-load.md](0741-backend-responsiveness-under-load.md)
- [remote-bandwidth.md](../../development/remote-bandwidth.md)
