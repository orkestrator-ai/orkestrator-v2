# Client reconnect and freshness

Checked against `main` at `20f6de91` (2026-10-25). All five code items are
done. Live qualification ran on 2026-10-31 against `main` at `931e5541`, found
four bugs and fixed them (see the [record](#live-qualification-record-2026-10-31)).
What is left is a dropped link between two real machines.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Outage workload**: a backend restart and a dropped tailnet link with several tabs and terminals open, on the shared `EventSource`, direct fetch and terminal WebSocket paths, showing spread reconnects and terminals returning with the main stream. Status: done on one machine, with the link simulated in the test; a real two-machine tailnet drop is not run (needs live evidence).
2. **Real-browser freshness checks**: the banner after 4 s of a real outage and clearing on reconnect, reads paused meanwhile, no indicator flicker on quiet `unchanged` reads, plus an Electron remote connection. Status: done.
3. **Terminal recovery under backpressure**: exact recovery after the new socket ladder, on HTTP/SSE and on the WebSocket. Status: done.
4. **Codex breaker with a real binary**: cooldown and half-open probe against a `codex` that keeps failing to start. Status: done; no bug found.
5. **Revisit the reasoned defaults**: the 4 s banner delay and the 5 min and 30 min breaker cooldowns, from task 1's data. Status: done for the banner delay (kept); the breaker cooldowns stay reasoned defaults, because no run can measure how long a user takes to fix an install.

The five code items are done and still match HEAD; nothing in this area has changed since #1257 (`e9b30126`), apart from an unrelated import in the Codex supervisor (#1295).

The analyses below are from 2026-10-27 and are kept for their reasoning. Their outcome is in the [live qualification record](#live-qualification-record-2026-10-31) and the decisions at the end.

### 1. Outage workload

**Problem.** Jittered reconnects and the read-coordinator pause are on by default but proved only by fake timers. If clients still retry in lock-step after a backend restart, or terminals stay stuck on fallback, every remote and desktop user sees it after an outage.

**Context.** The file explains why it could not run: a `dev:test` browser session lapses whenever the backend restarts, by design (`docs/development/agent-testing.md`, the session renewal paragraph after `:230`), so a restart lands on the login page. The dropped-link case needs a second machine. 0052 shares the two-machine setup, and 0031 batches two-machine runs.

**Investigation.** The policy and owners are where the file says: `reconnectDelayMs` and `ReconnectBackoff` at `packages/protocol/src/reconnect-backoff.ts:63` and `:90`; `createStreamBackoff` at `apps/web/src/lib/native/web-gateway.ts:162`, with `mainStreamBackoff` (`:173`) and `browserTerminalBackoff` (`:251`); the 2 s first retry and 30 s healthy interval at `:31` and `:40`; the socket ladder at `apps/web/src/lib/native/terminal-websocket-client.ts:116`. No live run has been recorded since 2026-10-25.

**Decisions.**

- **How to survive the backend restart in the harness?**
  - **Drive a direct (bearer) client against the restarted backend for the stream and terminal checks, and use a fresh `dev:login` link after the restart only to check the browser UI (recommended).**
    - Pros: needs no change to the login lapse, which is a security property; the bearer client sees the real reconnect ladder.
    - Cons: the shared same-origin `EventSource` path is exercised only up to the lapse.
  - **Add a test-only switch that keeps browser sessions across a backend restart on agent-test profiles.**
    - Pros: covers the same-origin path end to end.
    - Cons: weakens a deliberate security boundary, even if test-only; another flag to guard.
- **What counts as "spread out"?**
  - **Record reconnect attempt times per owner (content-free) and require them to span at least half the jitter window, with no two owners on the same retry tick (recommended).**
    - Pros: a measurable pass criterion that matches equal jitter.
    - Cons: needs a small timing probe in the page or client.
  - **A visual check of server logs.**
    - Pros: no instrumentation.
    - Cons: subjective; hard to repeat.
- **Order relative to other files.**
  - **Run it in the same two-machine session as 0052's baseline and 0048's outage and resume step (recommended).**
    - Pros: one setup for three files; the outage is the same event.
    - Cons: a long, coupled session; one failure can stall all three.
  - **Run it alone first.**
    - Pros: a smaller, clearer run.
    - Cons: repeats the two-machine setup.

### 2. Real-browser freshness checks

**Problem.** The banner, the read pause and the PR, diff-badge and Files indicators are on by default but checked only in component tests. A flickering indicator or a missing banner is user-visible in normal use.

**Context.** The banner delay is `CONNECTION_BANNER_DELAY_MS = 4_000` (`apps/web/src/components/layout/ConnectionStatusBanner.tsx:10`). Disconnects reach the coordinator through `apps/web/src/lib/transport-connectivity.ts:45`. Electron remote connections signal through the connection list, not the gateway stream.

**Investigation.** Unchanged since #1257. `getReadCoordinator().getDiagnostics().disconnected` is the observable the file names. The flicker case (a quiet `unchanged` safety read) can be produced without an outage, so part of this task needs no restart.

**Decisions.**

- **How to split the run?**
  - **Run the no-flicker checks now in a `dev:test --fixture` profile through `mise run test:agent:browser`, and the banner and pause checks with task 1 (recommended).**
    - Pros: half the task closes without the outage harness; uses an existing suite.
    - Cons: two runs.
  - **One run inside task 1.**
    - Pros: one session.
    - Cons: the cheap half waits on the hard one.
- **How to cover Electron remote?**
  - **Use `mise run test:agent:electron` with a second backend made unreachable (recommended).**
    - Pros: exercises the connection-list signal the browser path never uses.
    - Cons: the Electron suite has no such scenario yet, so a new spec is needed.
  - **A manual check on a real remote machine.**
    - Pros: realistic.
    - Cons: not repeatable; needs a person.

### 3. Terminal recovery under backpressure

**Problem.** Item 1 changed when the terminal socket resets its ladder, but exact recovery under backpressure has not been rerun since. A desync without exact recovery would corrupt what a user sees in a terminal.

**Context.** Transport invariant 5 in `AGENTS.md`: output may be dropped only under bounded backpressure, with an explicit desync signal and exact snapshot recovery.

**Investigation.** The deterministic coverage exists (desync and recovery cases in `apps/backend/tests/gateway-events.test.ts`, for example `:466` and `:2033`). No live run is recorded for either path since the ladder change.

**Decisions.**

- **Where to run it?**
  - **In a `dev:test --fixture` profile with a fixture terminal flooding output and a throttled client, on HTTP/SSE and then with `orkestrator-terminal-transport` set to `websocket` (recommended).**
    - Pros: single machine; needs no outage harness; compares the final screen with the snapshot exactly.
    - Cons: throttling in the browser is synthetic.
  - **Fold it into task 1's two-machine run.**
    - Pros: realistic link conditions.
    - Cons: couples a single-machine check to the hardest run.

### 4. Codex breaker with a real binary

**Problem.** The cooldown and half-open probe are proved only with a fake child. A real failure mode (a binary that exits at once, or hangs in `initialize`) might not trip or close the breaker as designed, leaving a workspace stuck or spawning too often.

**Context.** Decision 1 chose a 5 min cooldown doubling to 30 min (`bridges/codex-bridge/src/app-server/process-supervisor.ts:212`, `:220`, `:221`), with `stop()` waking the sleep (`sleepUnlessAborted`, `:492`, `:1564`).

**Investigation.** Tests are in `process-supervisor.test.ts`. No real-binary run has been recorded. A failing binary can be simulated without credentials by pointing the bridge at a wrapper that exits non-zero.

**Decisions.**

- **How to test it?**
  - **A gated no-credit test that runs the bridge against a wrapper script that fails N times and then execs the real pinned `codex`, with short cooldowns injected (recommended).**
    - Pros: exercises real spawn, exit and `initialize` paths; no credits; repeatable, like `live-resume-context.test.ts`.
    - Cons: the wrapper is still not a real broken install (a full disk, a corrupt binary).
  - **Break a real install in a disposable profile and wait out the real cooldowns.**
    - Pros: fully realistic.
    - Cons: takes 5 to 30 minutes per probe; fragile.
  - **Accept the fake-child tests and retire the item.**
    - Pros: no work.
    - Cons: the spawn and exit handling that matters most stays unproved.

### 5. Revisit the reasoned defaults

**Problem.** The 4 s banner delay and the breaker cooldowns are reasoned guesses. Too short a delay shows the banner on harmless restarts; too long a cooldown leaves a fixed install waiting.

**Context.** Decisions 1 and 6.

**Investigation.** The values are unchanged. Task 1's reconnect-time data is the input.

**Decisions.**

- **Keep this as a task, or fold it into task 1's pass criteria?**
  - **Fold it into task 1: record the restart-to-reconnect time and, if the first reconnect usually lands under 4 s, keep the delay (recommended).**
    - Pros: no separate run; a clear rule for keeping or changing the value.
    - Cons: says nothing new about the breaker cooldowns, which need task 4's data.
  - **Keep it as a separate tuning task after both runs.**
    - Pros: considers all the data together.
    - Cons: another open item for values that may well be fine.

This covers how clients behave across disconnects and staleness: how a
read-only stream comes back after an outage, and what a view tells the user
while its data may be behind. Every reconnect owner now uses the shared
jittered policy, the Codex breaker closes again after a quiet cooldown, the
read coordinator pauses while a transport is known to be down, and stale,
degraded, unsupported and remote freshness reach the UI. None of it has been
exercised against a real outage yet.

## Current state

### Reconnect

- `packages/protocol/src/reconnect-backoff.ts` is policy only:
  `reconnectDelayMs` (exponential, capped, equal jitter from an injected
  random source) and `ReconnectBackoff`, which resets the ladder only after a
  connection stayed up for `healthyAfterMs`. It is for read and stream
  recovery only.
- Adopted by every web gateway stream in
  `apps/web/src/lib/native/web-gateway.ts` through one policy
  (`createStreamBackoff`: first retry `EVENT_RECONNECT_DELAY_MS` 2 s, capped
  at 8 times that, healthy after `EVENT_STREAM_HEALTHY_AFTER_MS` 30 s), and by
  the OpenCode event monitor
  (`apps/backend/src/core/opencode-observation-stream.ts`). The gateway has
  one ladder per reconnect owner: `mainStreamBackoff` for the main stream,
  `browserTerminalBackoff` for the shared same-origin terminal `EventSource`,
  and `stream.backoff` for each direct terminal fetch stream. A cookie-mode
  `EventSource` is closed on its first error, whatever state that leaves it
  in, and rebuilt on the ladder from the current cursor. The main stream
  reopening retries any waiting terminal fallback at
  once (`retryWaitingTerminalFallbacks`). A main stream silent for 60 s, or an
  attempt unanswered after 20 s, counts as lost, and takes the terminal streams
  and terminal WebSocket with it (`dropSilentStreams`; the Electron client
  watches the same limits). A `401` is not an outage: the state goes back to
  `connecting`, so reads run and show it. A tab becoming visible or the
  browser's `online` event retries the waiting main stream and terminal
  fallbacks at once (`retryWaitingStreams`); the gateway's disposer removes
  both listeners. `web-gateway-reconnect.test.ts` covers both stream kinds on
  a manual timer queue.
- Terminal WebSocket client
  (`apps/web/src/lib/native/terminal-websocket-client.ts`): the socket has one
  `ReconnectBackoff` (`socketBackoff`: first retry 500 ms, cap 10 s, equal
  jitter, healthy after 30 s of `ready`). A deliberate foreground rebuild
  ends its health interval without counting a failure; going idle resets it. A
  drop announces a desync once, not once per failed attempt of the outage.
  Denied subscriptions use `reconnectDelayMs` per channel (500 ms to 10 s),
  reset when the server accepts the subscription. The gateway hands it the
  same jitter source and clock as its event streams (`eventReconnectRandom`,
  `eventReconnectNow`). Its repeated `onFallbackRequired` calls do not hurry
  the gateway's HTTP fallback.
- Codex `AppServerSupervisor.startWithRetry`
  (`bridges/codex-bridge/src/app-server/process-supervisor.ts`) retries with
  jitter over `DEFAULT_BACKOFF_MS` (250 ms to 10 s). After
  `DEFAULT_CIRCUIT_THRESHOLD` (5) failures within 60 s the breaker opens for
  `DEFAULT_CIRCUIT_COOLDOWN_MS` (5 min). The next demand after that gets one
  half-open probe start with no retries: success closes the breaker, failure
  re-opens it at once with the cooldown doubled, up to
  `DEFAULT_CIRCUIT_MAX_COOLDOWN_MS` (30 min). The backoff sleep wakes on
  `stop()` (`sleepUnlessAborted` on `stopController`), so shutdown no longer
  waits it out.
- Claude, Pi and Cursor have no transport reconnect loops. ACP's
  `requestPromptWithRetriableProviderRetries` re-sends a continuation prompt,
  so it is not a read retry and is out of scope.

### Freshness

- The gateway exposes `eventStreamConnection` (`idle`, `connecting`,
  `connected`, `disconnected`; it stays `disconnected` through retries until a
  stream opens). `apps/web/src/lib/transport-connectivity.ts` combines it with
  Electron's connection list (the active remote `reconnecting` or
  `unreachable`, or Local no longer available) and calls
  `ReadCoordinator.setDisconnected(true/false)`. `App.tsx` starts it and feeds
  the connection list. Browser `offline` is still not an owner.
- `ConnectionStatusBanner` shows one app-wide notice once the transport has
  been down for 4 s and clears on reconnect.
- `syncStatus` (`stale`, `degraded`, `unsupported`) marks the View PR action
  (tooltip adds the last successful check time from `lastSuccessfulCheckAt`)
  and the legacy diff badge. The Files panel shows `stale`/`degraded` of its
  revision feed as delayed announcements (it still polls every 5 s) and
  nothing for `unsupported`. Texts are in `apps/web/src/lib/view-freshness.ts`.
- `worktreeSnapshotStore` now keeps `remote`; the Files panel's Changes tab
  shows `stale` as "Base may be behind remote" (exact against the clone's
  refs) and `unknown` as "Base not fetched yet".
- The coordinator panel keys its legacy capability to the read coordinator's
  connection generation (`legacyRef` in
  `apps/web/src/components/projects/useCoordinatorPanelData.ts`), so a server
  switch within one mount probes the view command again.
- The behaviour is described in `../../architecture/event-snapshot-recovery.md`
  ("Freshness in the UI") and `../../architecture/remote-gateway.md`.

## Outstanding work

### Code

All done on 2026-10-25:

1. ~~Terminal WebSocket jitter.~~ Done. Socket reconnect uses
   `ReconnectBackoff`, denied subscriptions use `reconnectDelayMs`, both with
   an injected random source. Evidence in `terminal-websocket-client.test.ts`:
   "backs off repeatedly denied subscriptions instead of polling at a fixed
   interval" (updated: the top of the jitter range is the old exact ladder
   100, 200, 400, 800, 800), "jitters denied-subscription retries so clients
   denied together spread out" (50 … 400, and the ladder resets once
   accepted), and "backs off socket reconnects with jitter and resets only
   after a healthy connection".
2. ~~Codex breaker and cancellable sleep.~~ Done: quiet-interval cooldown with
   a single half-open probe (see Assumptions and decisions), and a backoff
   sleep that `stop()` wakes. Evidence in `process-supervisor.test.ts`: "after
   a quiet cooldown one probe start closes the breaker", "a failed probe
   re-opens at once, without retries, for a doubled cooldown", "concurrent
   demand during a probe joins it instead of spawning twice", and "stop wakes
   a start that is waiting out its backoff" (a 60 s backoff, stop returns in
   well under 5 s).
3. ~~Read coordinator disconnect signal.~~ Done for both transports. Evidence:
   `transport-connectivity.test.ts` (owners combine, the coordinator's
   `getDiagnostics().disconnected` follows, a stream already down at start is
   adopted, `connectionListDisconnected` for Local and remote states) and the
   two "gateway main stream connection state" cases in
   `web-gateway-reconnect.test.ts` (same-origin `EventSource` with a browser
   retry and a fatal close; direct fetch stream across a failed retry).
4. ~~Show freshness in the UI.~~ Done, including the optional last successful
   PR check time. Evidence: `view-freshness.test.ts`,
   `ConnectionStatusBanner.test.tsx` (a blip inside the delay never shows; the
   banner clears at once on reconnect), `worktreeSnapshotStore.test.ts`, and
   the freshness cases in `ActionBar.test.tsx`, `EnvironmentItem.test.tsx` and
   `FilesPanel.test.tsx`.
5. ~~Reset the coordinator panel's `legacyRef` on a connection change.~~ Done.
   Evidence: "probes the view command again after a server switch within the
   same mount" in `useCoordinatorPanelData.test.tsx`, which fails against the
   old per-mount flag.

### Qualification

Done on 2026-10-31; see the record below. Still open:

- A dropped link between two real machines. The link here is a proxy inside the
  test, which resets connections or goes silent. A real tailnet may behave
  differently, for example in how soon an OS gives up on a socket or fails a
  connect. Batch it with the two-machine runs of 0052 and 0048 (0031).
- A real PR on the View PR action. The credential-free profile records a PR URL
  and the action renders, but no PR state ever arrives from GitHub, so only the
  absence of flicker is shown, not a stale marker appearing and clearing.
- Hidden tabs. Headless Chromium keeps a page `visible`, so timer throttling in a
  background tab is not measured.

## Live qualification record (2026-10-31)

Against `main` at `931e5541` plus this change, on a disposable
`dev:test --profile todo-0051-outage --fixture --no-agent-credentials --agent-platforms codex`
profile, with load averages above 40 from other workers. How to rerun it is in
[`agent-testing.md`](../../development/agent-testing.md#live-client-outage).
Numbers are from the final run on the fixed code, except where a range covers
earlier runs. That run's only failure was the pass rule itself (decision 10), and
the case then passed three times out of three on the corrected rule.

**The harness.** `e2e/agent-testing/client-outage.spec.ts` puts each client behind
its own proxy (`client-outage-support.ts`), so nothing on the machine changes and
every attempt has an owner. `reset` drops connections, `blackhole` silences them
with no error, and a terminal stall stops reading from the gateway, which gives
real TCP backpressure. A backend restart signals the profile's own backend, after
checking its identity, and starts a replacement on the same data, port and token.

### Bugs found and fixed

1. **Same-origin streams retried in lock-step, for the whole outage.** The
   documented ladder only applied once an `EventSource` was CLOSED, and a network
   failure leaves it CONNECTING, so Chromium owned the retry. Measured across 3
   tabs: every 3 s with no backoff, first attempts at 3006, 3007 and 3009 ms (span
   3 ms), both streams of every tab. After the fix the rungs span up to 8428 ms,
   and attempts back off (1.6 s, 5.6 s, 12.3 s, 24.5 s, 33.2 s).
   Evidence: "tabs dropped together retry on their own jitter" and "the shared
   terminal socket returns on the ladder" in `web-gateway-reconnect.test.ts`.
2. **A silently dropped link was never noticed.** With no error and no answer, no
   banner appeared within 90 s, reads were not paused and no attempt was made; an
   open socket waits on TCP for many minutes. This is what a vanished tailnet peer
   looks like, so it was the main case the banner exists for. Now noticed at
   63.6 s on HTTP/SSE and on the WebSocket, and 63.5 s on an Electron remote.
   Evidence: the "a link that drops without an answer" cases in
   `web-gateway-reconnect.test.ts`, "a stream that stops its keepalives" in
   `backend-event-stream.test.ts`, and "sends keepalive events" in
   `gateway-events.test.ts`.
3. **The terminal WebSocket announced a desync on every failed attempt.** Each
   retry of an outage cost each terminal a snapshot read and a session read that
   could not succeed: 5 of each per terminal in a 45 s outage. Now once per drop,
   and 0 reads arrive once reads are paused. Evidence: "announces a desync once per
   drop" in `terminal-websocket-client.test.ts`, which fails with the guard removed.
4. **A refused credential looked like an outage.** With reads paused nothing could
   report the `401`, so a tab whose session lapsed showed "Reconnecting" for 52 s
   before reaching the login page. By the code (not run), a durable token that
   changed would have shown it for as long as the tab stayed open. Now 5.9 to 7.9 s
   after the backend listens. Evidence:
   the "a stream the gateway refuses for its credential" cases in
   `web-gateway-reconnect.test.ts`.

### Task 1: outage workload

Attempt times per owner, from the link. Pass rule: see decision 10.

| Case | Owners | Span of each main stream rung (ms) | Terminal behind main (ms) | Result |
| --- | --- | --- | --- | --- |
| Dropped link, shared `EventSource` (before the fix) | 3 tabs | 3, 2996 (a resend), 2996, 2995, 2997 | 0, -6, -4 | Lock-step: fails |
| Dropped link, shared `EventSource` | 3 tabs | 853, 210, 2858, 4189, 8428 | 4, -2318, -98 | Pass |
| Dropped link, terminal WebSocket | 3 tabs | 220, 814, 647, 4518, 7589 | 5, -8484, 3 | Pass |
| Backend restart, direct fetch | 4 clients | 891, 549, 2163, 4410, 9677 | -3859, 2, 3, 3 | Pass |
| Backend restart, direct and WebSocket | 4 clients | 611, 1466, 4178, 5284, 5127 | -7263, 3, -9299, 1 | Pass |

A negative figure means the terminal's own ladder found the backend first. The
dropped-link runs had 3 tabs rendering 4 terminals (3 sessions, one of them open in
two tabs). Outages lasted 45 s, long enough to reach the 16 s cap. Direct clients
got a desync notice when their terminal transport returned, and output written
during the outage reached both tabs rendering that terminal.

A backend restart with a real session (`backend restart, real UI`) showed the
banner at 4006 ms, reached the login page 5870 to 7870 ms after the backend
listened, and a fresh `dev:login` link recovered the UI.

### Task 2: freshness in a real browser

| Check | Result |
| --- | --- |
| Banner on a dropped link | 4005 to 4009 ms in every tab, on both transports; absent at 3 s |
| Reads paused | `disconnected` within 10 to 100 ms; 0 coordinator reads and 0 commands once paused, on both transports |
| Banner clears on reconnect | The moment the main stream answers (within 2 ms of it; 78 ms to 9.2 s after restore, depending on the rung) |
| Quiet `unchanged` reads | 9 safety passes in 45 s over `get_environment_diff_stats`, `get_pr_monitor_state` and `get_worktree_snapshot_revisions`, with the Files panel open, a diff badge and View PR showing: 0 indicator changes, 0 banner changes |
| Indicators across a whole outage | 0 changes in every tab (decision 5: the banner speaks for an outage) |
| Electron remote, real restart | `reconnecting` at 20 ms, banner at 4338 ms, reconnected 1874 ms after the backend listened; cleared, reads resumed |
| Electron remote, silent link | Banner at 63.5 s, recovered 953 ms after the link returned |

The Electron case is `connection-outage-electron.spec.ts`, in the Electron suite.

### Task 3: terminal recovery under backpressure

The transport was stalled at the link while the terminal printed 4,000,000 numbered
lines and an end marker, then released.

| Transport | Desync notices | Numbered lines rendered | Last number | Gaps | Last 200 lines against the snapshot |
| --- | --- | --- | --- | --- | --- |
| HTTP/SSE | 39 | 1029 | 4000000 | 0 | Equal |
| WebSocket | 1 | 1029 | 4000000 | 0 | Equal |

The notices show the bounded queue did overflow. The rendered screen ends exactly
where the authoritative snapshot does, with an unbroken sequence.

### Task 4: Codex breaker with a real binary

`bridges/codex-bridge/src/app-server/live-circuit-breaker.test.ts`, against the
pinned 0.166.0 through a wrapper that fails until the test "fixes the install",
with the production spawn, exit, `initialize`, termination and pidfile paths and a
throwaway `CODEX_HOME`. All 4 cases pass in 39.6 s; no bug found.

- **Exits at once:** 3 spawns open the breaker. Demand during the cooldown spawns
  nothing, and neither does waiting past it with no demand. Two concurrent demands
  share one probe with no retries. The failed probe doubles the cooldown. With the
  install fixed, the next probe reaches real `codex`, and the breaker closes. A later
  failure gets a whole ladder and the first cooldown again.
- **Hangs in `initialize`:** killed at the 30 s handshake timeout, opening the
  breaker with no process left running; the probe then recovers.
- **Missing or non-executable binary:** trips the breaker with no unhandled error,
  and recovers.
- **`stop()`:** wakes a real 60 s backoff in under 5 s and leaves no process behind.

One thing it does not cover: a binary that completes the handshake and then dies
resets the failure window each time, so it never trips the breaker. That is by
design (decision 1), and it spawns only on demand.

### Task 5: the reasoned defaults

The rule from the file: if the first reconnect usually lands under 4 s, keep the
delay. Over two runs of 5 quick restarts with 4 direct clients, the backend was down
464 to 1026 ms and all 40 first reconnects landed between 1021 and 1981 ms. The 4 s
delay stays: such a restart shows no banner, with about 2 s to spare. These backends
had no running agents or environments to restore, so a heavy backend will take
longer, and may show the banner. That is the banner doing its job.

The breaker cooldowns are unchanged. Task 4 shows they work as designed, but what
would tune them is how long a user takes to fix an install, which no run can
measure.

## Not verified

- A dropped link between two real machines (see Qualification).
- Timer throttling in a real background tab.
- Any event-stream reader other than the browser gateway and Electron's client.
  Neither fix was applied elsewhere.

## Assumptions and decisions

1. **Codex breaker: does it close, and how?**
   - Options: (a) stay open until the bridge restarts and only make the sleep
     cancellable; (b) close after the next generation stays healthy for a
     while; (c) close after a quiet interval via one half-open probe.
   - Choice: (c), a 5-minute cooldown, then one probe start on the next
     demand, with the cooldown doubling per failed probe up to 30 minutes.
     The existing "a successful start clears the failure window" is kept.
   - Why: (a) turns a transient fault (a full disk, a `codex` upgrade the user
     then fixes) into a workspace that needs a bridge restart nobody knows to
     do. (b) does not answer the question: an open breaker never starts a
     generation, so there is nothing to stay healthy. A probe that runs only on
     real demand cannot become a background restart loop.
   - Pros: self-healing; bounded cost (at most one spawn per cooldown, two an
     hour at the cap); no timers while nobody asks. Cons: a permanently broken
     install now costs a probe spawn every 30 minutes of demand instead of
     none; a user may wait up to the cooldown after fixing the cause (a bridge
     restart still clears it at once).
2. **Terminal WebSocket ladder: when does it reset?**
   - Options: (a) keep resetting on `ready`, as before; (b) reset only after
     the socket stayed ready for 30 s, like every gateway stream.
   - Choice: (b), via `ReconnectBackoff`. The defaults stay 500 ms to 10 s,
     faster than the event streams because a terminal is interactive.
   - Why: the constraint "only a connection that stayed healthy resets the
     ladder"; a server that accepts and then drops the socket must back off.
   - Pros: one policy everywhere; no lock-step after a restart. Cons: a
     socket that flaps every few seconds now waits up to 10 s between
     attempts, where it used to retry at 500 ms (the HTTP fallback carries
     the terminal meanwhile).
3. **Jitter source for the terminal socket.**
   - Options: a new `terminalWebSocketReconnectRandom` option, or reuse the
     gateway's `eventReconnectRandom`/`eventReconnectNow`.
   - Choice: reuse. Pros: one seam for tests and embedders; matches the
     gateway's fallback streams using the main stream's options. Cons: a test
     cannot give the socket a different source than the event streams.
4. **Where the disconnect signal comes from.**
   - Options: (a) only the browser gateway's main stream; (b) also a new
     Electron IPC event from `BackendHttpClient.onStreamState`; (c) also the
     existing Electron connection list (`transport`, `localAvailable`).
   - Choice: (a) plus (c), combined in `transport-connectivity.ts` (down while
     any owner says so).
   - Why: the connection list already publishes the active connection's
     transport state to the renderer, so no desktop change is needed; Local
     is a child process whose loss is already `localAvailable: false`.
   - Pros: no new IPC; one place decides. Cons: Electron Local is not paused
     for a stream hiccup that does not end the process (none is expected on
     loopback); `connecting` and `authentication-required` deliberately do not
     pause, so an auth failure stays visible as read errors.
5. **Where freshness indicators live** (the open question).
   - Options: per view only; one connection banner only; one banner plus
     per-view detail.
   - Choice: one banner for transport outages, per-view indicators only for
     failures specific to that view.
   - Why: during an outage every view is behind for the same reason, and
     marking each would be noise; a view-specific failure (a failed PR read,
     an exhausted retry) is invisible to the banner.
   - Pros: one clear message per cause. Cons: per-view indicators do not light
     up during an outage by themselves until their own reads fail.
6. **Banner delay.** 4 s, so a blip that recovers on the first 2 s retry
   never shows. Pros: no flicker on restarts. Cons: a real outage is reported
   4 s late.
7. **Files panel and `unsupported`.** The Files panel polls every 5 s, so its
   revision feed only speeds updates up. It shows `stale`/`degraded` as
   delayed announcements and nothing for `unsupported`, which is the
   designed polling path. Pros: no false alarm on older backends. Cons:
   departs slightly from the item's wording ("unsupported for the Files
   view").
8. **Times shown.** Last successful check and last fetch are absolute local
   times, not "3m ago": a relative age needs a clock read in render (the
   React Compiler purity rule) and goes stale itself. Pros: never implies a
   new measurement. Cons: less glanceable.
9. **Coordinator legacy capability.** Keyed to the read coordinator's
   connection generation rather than reset by a separate connection listener.
   Pros: the same identity the read results are fenced by; no extra
   subscription. Cons: a reconnect to the same server keeps the remembered
   capability (correct unless that server was upgraded in place, which the
   next server switch or remount corrects).

10. **What counts as "spread out".**
    - Options: (a) the file's rule as written: the attempts span half the jitter
      window, and no two owners share a retry tick; (b) some rung spans half its
      window, and at most 20% of owner pairs land within 20 ms across all rungs;
      (c) only the last rung must span half its window; (d) a visual check of logs.
    - Choice: (b), in `retriesAreSpread`.
    - Why: with several owners, independent jitter makes "no two ever coincide"
      fail by chance often, on a healthy client (the real runs had coincidences).
      (c) was tried first and failed a healthy run: three tabs spanned 3.6 s of the
      last rung's 8 s window, after 4.75 s on the rung before. Lock-step owners stay
      within milliseconds on every rung, so (b) still fails them.
    - Pros: measurable, stable, and it failed the real bug. Cons: laxer than the
      file's words, since one wide rung is enough.
11. **Same-origin streams: who owns the retry?**
    - Options: (a) close on any error and use the ladder; (b) leave the browser's
      retry and have the gateway send a jittered `retry:` per client; (c) keep it
      and document that the ladder only applies once CLOSED.
    - Choice: (a).
    - Why: `retry:` sets one fixed interval, so it can spread tabs but cannot back
      off. (c) leaves every tab retrying both streams every 3 s for the whole outage.
    - Pros: one policy on every transport; a shared socket retried as one owner.
      Cons: it no longer uses the browser's `Last-Event-ID` (the URL's cursor does
      the same job, and the gateway still accepts both).
12. **How to notice a silent link.**
    - Options: (a) watch the existing keepalives, adding a named keepalive event an
      `EventSource` can see, by request; (b) poll a lightweight route from each
      client; (c) move same-origin clients to fetch streams; (d) leave it, and
      document that the banner covers only links that answer.
    - Choice: (a), with a 60 s silence limit and a 20 s connect timeout.
    - Why: it adds about 20 bytes per 25 s per stream, and no request. (b) costs
      traffic that 0052 is trying to remove, and (c) gives up the shared socket
      that WKWebView's connection limit needs. (d) leaves the main case unhandled.
    - Pros: works on every client, and an older gateway is simply not watched.
      Cons: a silent link shows the banner after about 64 s, not 4 s; lowering the
      limit needs a shorter keepalive, and a tab frozen for over 60 s reconnects
      needlessly (harmless, since it resumes from its cursor).
13. **Where the watchdog lives.**
    - Options: (a) only on the main stream, which then drops the terminal
      transports; (b) on every stream.
    - Choice: (a).
    - Why: they share the link, and terminal streams carry no keepalive event today.
    - Pros: one timer per client. Cons: a terminal stream that stalls alone, with
      the main stream healthy, is still not noticed. No run produced that.
14. **A `401` on the stream.**
    - Options: (a) back to `connecting`, so reads run and show the failure, retries
      continuing; (b) a new `unauthorized` state; (c) leave it as `disconnected`.
    - Choice: (a). A same-origin stream cannot read its status, so an HTTP failure
      asks `gateway-settings`, once until the stream next opens.
    - Why: it matches decision 4, which already says an auth failure must stay
      visible as read errors. (b) adds a state nothing would use yet.
    - Pros: small, and honest about the cause. Cons: one extra request after an HTTP
      failure; a non-agent-test tab shows read errors rather than a login prompt.
15. **How to restart only the backend in a `dev:test` profile.**
    - Options: (a) signal the profile's backend after checking its identity, and
      start a replacement from the spec through `BackendProcess`; (b) restart the
      whole profile with `dev:stop` and `dev:test`; (c) add a restart command to the
      product.
    - Choice: (a).
    - Why: (b) takes minutes and restarts Vite, so it cannot measure a restart that
      takes under a second. (c) adds product surface for a test.
    - Pros: a real restart with real timings. Cons: Electron's Local shows as
      unavailable until the profile is restarted, and it reports an error dialog in
      its window; the replacement ends with the Playwright worker.
16. **Bearer clients for the restart cases** (the file's recommendation, followed).
    The real `createBrowserGatewayApi` runs in a real page with the durable token,
    as a page argument with traces and screenshots off. Pros: the real ladder through
    real browser networking, and no weakening of the session lapse. Cons: these
    clients have no UI, so the real UI is covered separately, up to the lapse.
17. **Order relative to 0052 and 0048.** The file recommended one two-machine
    session. The instruction for this run was to simulate the link inside the test.
    Pros: repeatable, and it found all four bugs. Cons: the real two-machine drop
    remains open.

## Constraints and rationale

- Keep the replay cursor, subscribe-before-replay, the connected frame's
  cursor echo and terminal desync recovery. Recovering a stream never
  resubmits an ambiguous prompt or approves an interaction.
- `ReconnectBackoff` drives read and stream recovery only, never prompt,
  approval or write retries.
- One reconnect timer per owner. The first retry stays responsive; only a
  connection that stayed healthy resets the ladder.
- Gateway terminal fallbacks:
  - They use the main stream's policy and options (`eventReconnectDelayMs`,
    `eventReconnectMaxDelayMs`, `eventReconnectRandom`, `eventReconnectNow`)
    rather than terminal-specific ones. That gives 2 s, then up to 16 s, with
    equal jitter. The first retry is never slower than the old fixed 2 s.
  - "Healthy" means open for 30 s, measured from `onopen` or the OK response.
    It is not "first frame received": an idle terminal sends no frames, and a
    server that sends one frame and then drops would reset the ladder every
    time.
  - Ladders are kept per owner. The shared same-origin socket has one ladder
    because it is one socket. Each direct terminal has its own because it has
    its own socket: a shared ladder would climb one step per terminal when a
    restart drops them all at once.
  - What skips the wait, without resetting the ladder (a failed early attempt
    waits for the next step):
    - the main stream opening, which retries every waiting fallback at once;
    - a new terminal stream: a mount, or the user's Reconnect, which
      re-listens;
    - the tab becoming visible, or the browser's `online` event, which retry
      the waiting main stream and every waiting fallback. A hidden tab's
      timers are throttled, and the outage may have ended mid-wait. This
      matches the read coordinator, which retries reads on `online`.
  - What does not skip it:
    - narrowing the shared filter;
    - the terminal WebSocket asking for fallback again.
  - After a silent drop, the main stream reopening also retries any terminal
    attempt still unanswered, since only its own TCP timeout would end it.
  - Removing the last fallback terminal resets the shared ladder.
- `401` is not an outage, and a silent link is one: see decisions 12 and 14.
- Browser `offline` is deliberately not treated as disconnected: a local
  desktop backend stays reachable without internet. `online` only triggers a
  reconcile, and the gateway retries any stream waiting out its backoff.
- A freshness indicator must not imply a new measurement after a failed read;
  stale data keeps its original `observedAt`.
- Keep the existing heartbeats: the gateway's `KEEPALIVE_MS` (25 s) also
  advances the stream cursor, Claude's SSE sends every 30 s, and Codex checks
  every 5 s and sends at 5 s active and 30 s idle.
- Any polling reduction that relies on bounded hydration must cite its fault
  coverage and add rows for its own view. The coverage list now lives in
  `../../architecture/event-snapshot-recovery.md` ("Adopting the contract").

## Related

- [0052-remote-client-bandwidth.md](0052-remote-client-bandwidth.md): remote transport
  measurement, which shares the outage and slow-client workloads.
- [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md):
  observation invalidations and the read coordinator's native views.
- [0048-recurring-work-qualification.md](0048-recurring-work-qualification.md): the
  wider real-stack and two-client QA.
- `../../architecture/event-snapshot-recovery.md` (sequence semantics,
  supported peers, `remote` freshness, freshness in the UI) and
  `../../architecture/remote-gateway.md`. The living-doc drift this file
  listed is fixed: the step labels and plan pointers are gone from
  `event-snapshot-recovery.md`, its coverage list is inlined, and
  `remote-gateway.md` says that the 25 s keepalive also advances the cursor.

## Replaces

- `docs/improvements/recurring-processes/plan/10-bridge-and-transport-lifecycle.md`
  (remaining transports and their deferrals; the native chat-store ladder it
  listed was deleted in #970)
- `docs/improvements/recurring-processes/plan/11-recovery-and-resource-bounds.md`
  (`syncStatus` not rendered, real-browser QA, the recovery coverage list)
- `docs/improvements/recurring-processes/plan/06-client-read-coordination.md`
  (`setDisconnected` has no caller)
- `docs/improvements/recurring-processes/plan/04-container-git-fetch-policy.md`
  (no client renders `remote`)
- `docs/improvements/recurring-processes/plan/09-secondary-client-processes.md`
  (coordinator legacy capability per mount)
