# Terminal echo under load: follow-ups

## Task analysis

Analysed 2026-11-19 against main at `0007f0e66`. From the terminal key-to-echo
latency work ([terminal-latency.md](../../development/terminal-latency.md)),
which measured the backend's share, cut it, and left these three.

### Tasks

1. **Move headless parsing and serialization off the backend's event loop**: Status: open.
2. **Measure and reduce the renderer's parsing of hidden terminal tabs**: Status: open.
3. **Check typing latency in a real browser on a loaded `dev:test` profile**: Status: open.

### 1. Move headless parsing and serialization off the backend's event loop

**Problem.** After the scanner rewrite, metered parsing and coalesced
checkpoints, the heavy level of `apps/backend/scripts/terminal-latency.ts`
still shows backend echo p99 of about 21 ms and loop-lag p99 of about 14 ms.
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
p95 8.6 ms and loop-lag p99 6.6 ms in one run, which bounds what a worker
could recover. About 20 call sites touch `session.terminal` or
`session.serializer`, including the synchronous `serializedState` used by
checkpoints, snapshots and the graceful-shutdown checkpoint.

**Decisions.**

- **Where the headless terminals run.**
  - **A worker per backend holding every session's terminal, behind an async interface (recommended once task 3 shows the remaining stall is felt).**
    - Pros: parsing and serialization leave the loop entirely; uses a second core.
    - Cons: `serializedState` and its callers become async; the worker needs `@xterm/headless` at run time, which means either a separately bundled worker entry in the backend, Electron and CLI builds or an inlined bundle; restart and crash handling for the worker.
  - **Keep the metered scheduler and lower its budgets.**
    - Pros: no packaging change.
    - Cons: the work stays on the loop; smaller turns only spread it out, and throughput falls when the loop is busy.
- **Serialization cost alone.**
  - **Serialize at most once per checkpoint interval under sustained output (time-only trigger while the parser is behind).**
    - Pros: fewer 10 ms holds.
    - Cons: a crash loses up to the interval's screen state rather than up to a mebibyte of output; a durability change to agree first.
  - **Leave the trigger as it is (recommended until the worker decision).**
    - Pros: no durability change.
    - Cons: about four serializations a second at the heavy level.

### 2. Measure and reduce the renderer's parsing of hidden terminal tabs

**Problem.** In the benchmark, a typing client that also parses its
environment's load terminals (as the renderer parses every mounted terminal
tab) sees heavy-level key-to-echo p95 of about 26 ms against about 17 ms when
it parses only its own terminal: the client's own thread delays the echo.

**Context.** Hidden terminal tabs of the selected environment stay subscribed
and parse their output (decided 2026-10-27 in
[remote-bandwidth.md](../../development/remote-bandwidth.md), because a
detached tab would come back with less history). The benchmark's headless
parse stands in for xterm.js in the renderer but not for its rendering.

**Investigation.** Not measured in a real renderer yet; task 3 gives the
real figure.

**Decisions.**

- **How to cut the renderer's share.**
  - **Measure first in a real browser (task 3), then decide (recommended).**
    - Pros: the benchmark's headless parse may over- or under-state xterm.js.
    - Cons: one more step before any change.
  - **Batch hidden tabs' writes into xterm.js on idle callbacks, keeping the subscription.**
    - Pros: keeps the 2026-10-27 decision's exact history; typing tab's frames go first.
    - Cons: hidden tabs lag behind and catch up on reveal.
  - **Unsubscribe hidden tabs and restore them from the backend snapshot on reveal.**
    - Pros: no hidden parsing at all.
    - Cons: reverses the 2026-10-27 decision; the snapshot halves scrollback when it is large.

### 3. Check typing latency in a real browser on a loaded `dev:test` profile

**Problem.** Every figure so far is from the loopback benchmark with
headless clients. Whether typing feels responsive in the real renderer while
several agents and builds run is not yet observed.

**Context.** An isolated `dev:test --fixture` profile with fixture
environments can run build commands in terminals and agents with a fake
model; Playwright can type into one terminal and time each echo with
`performance.now()` in the page ([agent-testing.md](../../development/agent-testing.md)).

**Investigation.** Not started.

**Decisions.**

- **How to load the profile.**
  - **Fixture terminals running `producer.ts` build and tool loads, plus agents on a fake model (recommended).**
    - Pros: repeatable; no provider credentials; same load shapes as the benchmark.
    - Cons: fake-model agents produce less transcript work than real ones.
  - **Real agents on real providers.**
    - Pros: real transcript shapes.
    - Cons: needs credentials and costs money; not repeatable.

## Constraints and rationale

- Nothing may drop terminal output to save latency: history order and the
  snapshot's exact screen are what reconnect recovery depends on.
- Metrics and reports stay content-free.

## Related

- [terminal-latency.md](../../development/terminal-latency.md)
- [0741-backend-responsiveness-under-load.md](0741-backend-responsiveness-under-load.md)
- [remote-bandwidth.md](../../development/remote-bandwidth.md)
