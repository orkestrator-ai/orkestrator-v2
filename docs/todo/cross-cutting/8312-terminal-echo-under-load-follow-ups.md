# Terminal echo under load: follow-ups

## Task analysis

Analysed 2026-11-26 against main at `8950e12e2` (first analysed 2026-11-19
at `0007f0e66`, then 2026-11-20 at `0b778d995` and 2026-11-22 at
`dd1391427`). From the terminal key-to-echo latency work
([terminal-latency.md](../../development/terminal-latency.md)), which measured
the backend's share, cut it, and left these follow-ups. The real-browser
measurement (task 3), the hidden-tab change (task 2) and the transcript-growth
investigation (task 4) are done; their figures are in
[terminal-latency.md](../../development/terminal-latency.md#in-a-real-browser).
Task 1's heavy-level measurement is done too and found no felt backend load,
so the worker was not built; the task stays open on a stated trigger.

### Tasks

1. **Move headless parsing and serialization off the backend's event loop**: Status: open (waits on a felt backend stall by the rule below; measured not felt at the heavy level on 2026-11-26).
2. **Measure and reduce the renderer's parsing of hidden terminal tabs**: Status: done.
3. **Check typing latency in a real browser on a loaded `dev:test` profile**: Status: done.
4. **Find why echo slows as agents' transcripts grow**: Status: done.

### 1. Move headless parsing and serialization off the backend's event loop

**Problem.** The original heavy-load run of `apps/backend/scripts/terminal-latency.ts`
reported backend echo p99 of about 21 ms and loop-lag p99 of about 14 ms
after the first optimization pass. Those figures predate the benchmark and
checkpoint corrections.
xterm's headless parser is now about half of the backend's CPU under that
load, and each full `SerializeAddon.serialize` call holds the loop 9 to 12 ms.

**Context.** `TerminalHistory` (`apps/backend/src/core/terminals/history.ts`)
owns a headless xterm and a `SerializeAddon` per terminal. Writes go through
`HeadlessParseScheduler` (`terminals/parse-scheduler.ts`); serialization is
synchronous in `serializedState`. The backend ships as a Bun bundle
(`apps/backend/scripts/build.ts`) inside Electron and the CLI package, and
the only backend worker today (`packages/protocol/src/node/essential-log-worker.ts`)
inlines its source with `eval: true` so no separate worker file has to be
packaged.

**Investigation.** Turning durable history off entirely gave heavy-level echo
p95 8.6 ms and loop-lag p99 6.6 ms in one loopback run, which bounds what a
worker could recover. The headless terminal and its serializer are touched
from about 20 places, nearly all inside `terminals/history.ts`, including the
synchronous `serializedState` used by checkpoints, snapshots and the
graceful-shutdown checkpoint.

On 2026-11-20 the real-browser run (task 3) measured the backend's share as
the page sees it: with the load running only on the backend (unmounted load
terminals in the typing environment and agents in other environments),
key-to-echo was p50/p95/p99 27.6/40.1/44.1 ms against 37.0/38.3/40.9 ms idle at the `busy`
shape, and 27.0/31.4/42.3 ms against 32.0/35.3/36.2 ms with six build and three
tool terminals. Those were historical runs. The original harness could
confuse unavailable event-loop counters with zero stalls and did not verify
that the requested load covered each measurement. The worker remains open
pending a comparison with the corrected harness.

On 2026-11-22 the corrected harness, with keys spread over the frame (task
4), compared the busy shape over three rounds: backend-only means 26.5 to
27.3 ms against idle 27.1 to 27.3 ms, p95 34 to 35 ms in both, no late
backend ticks. At the busy level the backend's load is not felt.

On 2026-11-26 the heavy level (six build and three tool terminals with
unmounted session keys in the typing environment and four fake-model agents
in other environments) was repeated against idle with the corrected harness
on `beelink2` against `main` at `8950e12e2`: two runs of three rounds each, in
opposite starting orders, with 200 measured keys per cell and no timeouts.
For each producer, the output revision advanced in the same generation
between snapshots bracketing typing. The agent stream checks confirmed
coverage through the final echo. The rule for "felt" was written down before
the first heavy cell ran:

> The backend load is felt if (a) the median of backend-only's three per-round
> p95s, or of its three p99s, is more than 5 ms above idle's matching median
> **and** backend-only is more than 5 ms worse than the same round's idle on
> that percentile in at least two of the three rounds; or (b) the backend's
> event-loop monitor records any tick at least 100 ms late in a backend-only
> cell.

| Run | Variant | Means, r1 / r2 / r3 ms | p95, r1 / r2 / r3 ms | p99, r1 / r2 / r3 ms | Late ticks (≥100 ms) |
| --- | --- | --- | --- | --- | --- |
| 1 | idle | 27.2 / 27.2 / 27.1 | 34.8 / 34.6 / 34.4 | 35.8 / 37.3 / 35.3 | 0 / 0 / 0 |
| 1 | backend-only | 26.6 / 26.6 / 26.9 | 34.2 / 34.4 / 34.1 | 35.1 / 35.5 / 34.9 | 0 / 0 / 0 |
| 2 | idle | 27.1 / 27.0 / 27.4 | 34.6 / 34.0 / 34.3 | 35.4 / 34.5 / 35.0 | 0 / 0 / 0 |
| 2 | backend-only | 26.8 / 27.0 / 26.9 | 34.3 / 34.5 / 34.7 | 35.4 / 35.4 / 35.3 | 0 / 0 / 0 |

Medians of the per-round values: run 1 p95 34.6 (idle) against 34.2
(backend-only), p99 35.8 against 35.1; run 2 p95 34.3 against 34.5, p99 35.0
against 35.4. No round in either run had backend-only more than 1 ms worse
than idle at p95 or p99, and the monitor recorded no late tick or stall in any
cell. The heavy load did not meet the felt rule. Browser resource timing
measured keystroke request-to-first-byte (`responseStart - requestStart`) p99
at 1.8 to 4.0 ms in backend-only cells, 0.9 to 1.0 ms in five idle cells and
4.1 ms in the first idle cell. Request-to-first-byte p95 was 1.1 to 1.6 ms
under load and 0.8 to 0.9 ms at idle. The [per-round request timings](../../development/terminal-latency.md#heavy-load-backend-only-with-the-corrected-harness-8312-task-1)
include both percentiles. Frame quantization may explain why these request
timing differences produced little change in measured echo latency.

**Decisions.**

- **Where the headless terminals run.**
  - **A worker per backend holding every session's terminal, behind an async interface (the design to build once a measurement shows the remaining stall is felt by the rule above).**
    - Pros: parsing and serialization leave the loop entirely; uses a second core.
    - Cons: `serializedState` and its callers become async; the worker needs `@xterm/headless` at run time, which means either a separately bundled worker entry in the backend, Electron and CLI builds or an inlined bundle; restart and crash handling for the worker. The corrected browser runs at the busy (2026-11-22) and heavy (2026-11-26) levels show nothing for it to recover as the page sees it.
  - **Keep the metered scheduler and lower its budgets.**
    - Pros: no packaging change.
    - Cons: the work stays on the loop; smaller turns only spread it out, and throughput falls when the loop is busy.
  - **Leave it until a measurement shows a felt stall (recommended; decided 2026-11-26 after the heavy run).**
    - Pros: no async conversion or packaging risk for no measured gain; the browser spec reruns the check (`backend-only` against `idle`).
    - Cons: a heavier or different load (more terminals, a slower host, a remote client) may still feel it, and nobody has measured those.
    - Build the worker only when a backend-only browser-spec run meets the felt rule above, at any load shape or on any host. Use the spec to check reports of typing lag while builds run. A change that adds work to the headless path (a larger scrollback, more frequent serialization, a second headless consumer) requires rerunning the heavy `idle,backend-only` cells before it merges. Keep the worker deferred if the rerun falls below the felt threshold.
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

**Investigation.** Done on 2026-11-22; figures and method in
[terminal-latency.md](../../development/terminal-latency.md#why-the-echo-seemed-to-slow-as-transcripts-grew-8312-task-4).
Reproduced: idle p50 24.2, 32.4, 32.5 ms and backend-only 21.2, 32.8,
28.5 ms over three rounds. Nothing in the product grew. The backend's CPU
profile sampled at the same rate in every round, and the keystroke's server
time stayed at 0.6 ms. The page's CPU profiles and traces showed it idle
about 93% of each idle cell, with no long tasks. The work that grew was
Playwright's own step bookkeeping in the test worker: `_findLastPredefinedStep`
walks the case's whole step tree on every API call, and with `_addStep` and
`onApiCallBegin` it went from 22% to 34% of the worker's CPU between the
first and third idle cells. Every `route.fallback()` and `route.fulfill()` of
the spec's module route is such a call, and loaded rounds reload the app in
four driver pages.

The slower worker reached the echo two ways. Chromium held every command
request, keystrokes included, until the module route's handler answered:
4.4 to 7.1 ms in idle and 5.9 to 9.0 ms in backend-only from rounds 1 to 3.
The worker also shifted the keys' frame phase because the spec typed at a
fixed cadence that included its own round trips. Chromium defers ordinary tasks after a discrete input until the
next frame. So the browser client's 8 ms typing timer fired at 8 ms when a
frame fell inside those 8 ms and at about 15 ms otherwise, and the echo
painted one or two frames after its key. Traces showed the phase move: 155
of 200 keys in the one-frame case in round 1, only 40 in round 2, and the
median moved with it.

The fix is in the harness: the module route no longer matches the gateway's
API, and key gaps are spread over a frame. Afterwards both variants stayed
flat across rounds: idle means 27.2, 27.1 and 27.3 ms, backend-only 27.1,
27.3 and 26.5 ms.

**Decisions.**

- **How to find it.**
  - **Profile the backend and the page across rounds with the browser spec (recommended; done).**
    - Pros: the spec already reproduces it on a fake model; a CPU profile of each side names the growing work.
    - Cons: needs a profile run per side.
  - **Measure with the loopback benchmark.**
    - Pros: quicker to run.
    - Cons: its agents are simulated and do not grow real transcripts, so it may not show the effect.
- **What to fix.**
  - **The harness: keep the gateway's API out of the module route, and spread key gaps over a frame (recommended; done).**
    - Pros: removes both paths by which the worker reached the measurement; keys sample every frame phase, as a person's do; no product change for an effect the product does not have.
    - Cons: the spec's p50s are no longer comparable with the fixed-cadence runs recorded before; the worker's per-call cost still grows within a case, just off the measured path.
  - **Send the browser's keystrokes at once (typing timer 0), as the Electron relay does.**
    - Pros: a keystroke leaves 10 ms sooner (0.5 against 10.3 ms after its keydown); keys typed during a send still coalesce.
    - Cons: measured no echo gain once keys were not phase-locked (means 27.4 to 27.7 against 26.5 to 27.3 ms), because the echo waits behind the same deferred frame; changes a shared protocol default for every browser client.
  - **Shorten the spec's case so fewer steps accumulate (fewer rounds, no driver page reloads).**
    - Pros: smaller worker cost.
    - Cons: hides the drift rather than taking the worker off the measured path; the multi-round comparison is the point of the spec.

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

### Task 4: the cause was the harness, so the fix is in the harness

Profiles of the backend and the page showed no work growing with the
transcripts, while the Playwright worker's step bookkeeping did. The harness
changes take the worker off the measured path. `MODULE_ROUTE_URL` in
`e2e/agent-testing/browser-test.ts` excludes `/__orkestrator/…` from the module
route, and the spec spreads key gaps with `keyPhaseOffsetMs`. The route uses
a regular expression rather than a function, because Playwright can match a
regular expression in its own server and continue other requests without a
handler call or a recorded step; a function sends every request to the case.
This changes the route for every browser-suite case: the gateway's API was
always answered with `route.fallback()`, so only who answers it changes.

### Task 4: the browser typing timer stays at 8 ms

An A/B with the corrected harness showed that sending at once (timer 0) gets
a keystroke to the backend 10 ms sooner but paints its echo no sooner in
headless Chromium at 60 Hz. With no measured gain, the shared protocol default
was left alone. A higher refresh rate, another browser or a remote client may
behave differently. Nobody has measured those.

### Task 4: what the spec now records

Each cell records key-to-echo latency, keydown phase relative to the preceding
animation frame, its `startedAt` and the runner's `monotonicStartUs`. Matched
typing writes contribute to `keyRequestMs` (`sent`, `start`, `queued`, `server`,
`duration`, `echoAfterStart`). `keyRequestCounts` exposes missing or ambiguous
correlations and missing resource timings. Profiling records export time
separately from the typing window, which ends at the final echo. See the
[trace selection and capture limits](../../development/terminal-latency.md#in-a-real-browser).

### Task 1: not built

The ticket conditions the worker on a measured backend stall. The original
runs compared idle and backend-only typing. Review found gaps in verification
of producer activity, stream duration and stall counters, so the comparison
was repeated with the corrected harness: at the busy level on 2026-11-22 and
at the heavy level on 2026-11-26. Neither met the felt rule, so no production
code changed.

### Task 1: the felt rule, and why it is stated this way

The rule (in task 1's investigation) was recorded before the heavy run, so the
result could not shape it. It compares percentiles rather than means because
a stall shows in the tail first. The 5 ms margin is above the run-to-run
spread the corrected harness shows between identical idle cells (about 1 ms at
p95 and up to 3 ms at p99 with 200 keys, where nearest-rank p99 is the
third-slowest key)
and below a third of a 60 Hz frame. The "two of three rounds" clause stops one
slow key in one round from deciding it. Late backend ticks count on their own
because a 100 ms stall is felt whatever the percentiles say.

### Task 1: kept open with a trigger rather than closed

The heavy level is the largest shape either harness defines, but a slower
host, a remote client, or more terminals than nine have not been measured,
and the worker design and its packaging constraints are recorded here. Keeping
the task with a concrete trigger (in its decisions) keeps that analysis next
to the condition that would reopen it; closing would retire the file and move
it into git history.

## Constraints and rationale

- Nothing may drop terminal output to save latency: history order and the
  snapshot's exact screen are what reconnect recovery depends on.
- Metrics and reports stay content-free.

## Related

- [terminal-latency.md](../../development/terminal-latency.md)
- [0741-backend-responsiveness-under-load.md](0741-backend-responsiveness-under-load.md)
- [remote-bandwidth.md](../../development/remote-bandwidth.md)
