# 10 — Tighten lifecycle timers and transport retry policy

Status: Implemented with recorded deferrals. Cursor/Pi lifecycle ownership,
removal of ACP's 50 ms disconnect poll, and capped jittered backoff for the
OpenCode event monitor and web gateway stream all landed. The remaining
transports are inventoried with reasons; the plan treats step 10's
optimizations as optional where there's no measured benefit. They are:
- terminal WebSocket jitter (already exponential);
- the gateway terminal fallbacks (each reopen forces a snapshot);
- the Codex supervisor breaker and its non-cancellable backoff sleep (bounded
  at 10 s; the permanent breaker is an intentional failure policy with no
  recurring cost).
The ACP reduction is derived (20 wakeups/s per in-flight request removed);
step 12 records the aggregate results. See Completion notes. Dependencies: 01, 02.
Finding: F09; inventory L01–L14.

## Outcome

Every long-lived owner can dispose its timers and observers completely, outages
do not produce synchronized retry storms, and protocol/safety timers preserve
their original guarantees. Optimize measured hotspots selectively.

## Cursor and Pi lifecycle

Targets: `bridges/cursor-bridge/src/server.ts`, `bridges/pi-bridge/src/server.ts`
and `packages/protocol/src/parent-watchdog.ts`.

1. Retain idle-sweep and parent-watch stop handles in the server lifecycle owner.
   Clear them before awaiting shutdown disposal. Make start behavior explicit:
   idempotent while started, or reject repeated start before installing anything.
   Do not promise restart of module-global closed state without implementing it.
2. Reuse the common parent-watchdog implementation where its semantics fit,
   preserving the current five-second check requirement rather than accidentally
   inheriting its fifteen-second default.
3. Coalesce per-session detach work and capture generation. A new prompt or
   interaction appearing while detachment is pending must prevent unsafe cleanup.
   Preserve Pi's blocked/compacting/dispatching protection and Cursor's running
   background-child protection.
4. Catch timer callbacks and shutdown rejections. Keep fatal rejection guards as
   the last line of defense, not as expected error handling. Deny/withdraw
   approvals under each bridge's existing contract before dropping ownership.

Tests: explicit shutdown without process exit leaves zero lifecycle timers;
repeated start cannot duplicate work; late callbacks do nothing; parent death
triggers one shutdown; active/blocked/newly-dispatched sessions do not detach;
idle sessions do detach and later reattach to existing history.

## ACP disconnect fallback

Target: `bridges/acp-bridge/src/acp-server.ts` and owning HTTP tests.

1. Establish why the 50 ms per-request fallback exists using tests/history and
   supported runtime behavior. Count concurrent long requests and callback cost.
2. Exercise request abort, peer half-close, full socket close, proxy disconnect,
   response close, keep-alive reuse and already-destroyed sockets. Use real
   sockets as well as unit seams; event assumptions are the behavior under test.
3. If events cover all supported cases, remove periodic fallback or restrict it
   to the documented exceptional operation. Otherwise consolidate one bounded
   server-level sweep over active cancellable requests at a justified cadence.
4. Preserve read cancellation without cancelling a user turn simply because its
   view disappeared. Remove listeners/registrations on both success and failure.

Acceptance: equivalent cancellation latency and no orphaned request work, with
measured reduction in periodic callbacks. Keep the old bounded fallback if proof
is insufficient; document that as an intentional deferral.

## Reconnect policy

Targets: `opencode-provider.ts`, web gateway, terminal WebSocket client, native
chat stores and bridge process-supervisor retry paths.

1. Inventory existing retry owner, reset condition, cap and cancellation for
   each transport. Share a pure backoff/jitter policy where useful, not transport
   state or dispatch retry decisions.
2. Trial exponential capped jitter for repeated read/stream reconnect failures.
   Keep initial reconnect responsive; reset after a meaningful healthy period,
   not merely after a connection that immediately closes. Limit one reconnect
   timer per owner and bound pending subscriptions/channels.
3. Preserve replay cursor/generation, subscribe-before-replay, connected-frame
   cursor echo and explicit reconciliation on expiry/gap. Recovery of a stream
   never automatically resubmits an ambiguous prompt or approves an interaction.
4. Audit every abort consumer for owned rejection handling, including
   `reader.cancel()`. Preserve the existing real-client OpenCode disposal test.
   Do not wrap transport operations in a scheduler that blocks the Codex stdout
   read loop on rendering, SSE writes or browser work.

## Heartbeats, maintenance and batching

Keep gateway's 25-second heartbeat/cursor advancement, Claude's 30-second
heartbeat and Codex's current active/idle protocol behavior until transport
measurement supports any change. A shared clock per owning process is optional;
there is no reason for an IPC scheduling service across bridges.

Retain coarse Codex/Claude transcript cleanup, one-minute Cursor/Pi idle sweeps,
and six-hour log retention unless their measured cost warrants a due-index.
Keep storage/controller/test/toolchain lock heartbeats and approval/auth expiry
independent of soft-work pools. The validation worker's 500 ms persistence can
be split into liveness versus changed-result writes only with cross-process
crash-recovery and cancellation proof; do not simply slow its heartbeat.

Preserve PTY/terminal-history/message/persistence flush bounds and maximum
latency. Data-triggered debounce and bounded readiness loops are intentionally
outside broad recurring-timer conversion. iOS's bounded web readiness check
remains a startup concern; test it if shared client readiness semantics change.

## Rollback

Keep lifecycle disposal improvements even when retry cadence experiments revert.
Revert each transport's policy independently and confirm one active driver.
Any heartbeat/replay regression blocks rollout; restore the known transport
policy before proceeding with unrelated efficiency changes.

## Completion notes

Implemented 2026-09-25 on branch `worktree-agent-ae81c6a9a0c440d4a`, based on
`b9bd00fa`. Steps 01/02 had not landed, so no before/after production
measurements exist yet (see Deferrals). Commits:

| Commit | Scope |
| --- | --- |
| `a48792dc` | Cursor/Pi lifecycle ownership, shared parent watchdog, coalesced idle detach |
| `3419f9d2` | Pure reconnect backoff policy; OpenCode monitor and web gateway main stream adopt it |
| `a2236dfb` | ACP per-request 50 ms disconnect poll removed; flaky-test records |

### Cursor and Pi lifecycle (`a48792dc`)

- `packages/protocol/src/bridge-lifecycle.ts` adds `BridgeLifecycle`, now the
  lifecycle owner for both bridges (`bridges/{cursor,pi}-bridge/src/server.ts`).
  It keeps the idle-sweep and parent-watch handles and clears both
  synchronously when shutdown begins, before awaiting disposal.
- Repeated start is rejected before anything is installed. This covers a
  concurrent second call, a second call after start, and a call after
  shutdown. Restart is deliberately unsupported: shutdown releases the
  module-global registries. A shutdown that arrives while `open` is still
  awaiting prevents any timer from being armed.
- Late callbacks do nothing. The sweep checks the lifecycle phase, and the
  parent watchdog ignores a callback that was already due when `stop()` ran.
  A sweep that throws is reported with its error class only.
- `requestExit()` runs one shutdown and one exit, however many signals or
  watchdog ticks call it. A failed shutdown is reported and still exits
  (code 1), so an orphan never lingers.
- Signal handlers stay installed until close settles, so a repeated signal
  joins the running shutdown. They are then removed.
- The watchdog is the shared `startParentWatchdog`, called with each bridge's
  own 5 s interval (not the 15 s default). It now accepts injected
  `IntervalTimers`; `packages/protocol/src/fake-intervals.ts` is the test clock.
- `idle-detach.ts` in each bridge owns the sweep:
  - At most one pending detach per session. Shutdown awaits detaches already
    in flight.
  - Protections are unchanged:
    - Pi skips running, compacting, dispatching and blocked sessions.
    - Cursor skips a running turn or a live background child
      (`sessionIsWorking`), and dispatching sessions.
    - Both also skip a session with an attach in flight.
  - The decision and the release happen in one synchronous step: both detach
    functions null the live handle before their first await and dispose only
    the handles they captured. A prompt that reattaches while the old disposal
    is still pending gets a new generation that disposal cannot touch. This is
    now tested in both bridges.
- Approvals:
  - Pi denies every parked approval before persistence drain and release.
    This is now covered through parent death in `server-lifecycle.test.ts`.
  - Cursor holds no parked approvals by contract: `/approvals` answers an
    empty list, and the SDK sandbox path fails closed.
- Tests (all with a fake clock):
  - `packages/protocol/src/bridge-lifecycle.test.ts`
  - `tests/unit/protocol/parent-watchdog.test.ts`
  - `bridges/{cursor,pi}-bridge/src/idle-detach.test.ts`
  - `bridges/{cursor,pi}-bridge/src/server-lifecycle.test.ts`, which uses the
    real HTTP server
  - Together they cover:
    - zero armed timers after an explicit shutdown with no exit
    - a repeated start that cannot duplicate work
    - late callbacks that do nothing
    - parent death causing one shutdown and one exit
    - active, blocked, background-child and newly dispatched sessions that do
      not detach
    - idle sessions that detach and later reattach, or resume, the same
      conversation

### ACP disconnect fallback (`a2236dfb`)

History:

- `git log -S disconnectPoll` finds exactly two commits:
  - `53d4b3f6` (2026-08-13, #341) added the poll, next to the same four event
    listeners, when the ACP bridge was introduced.
  - `7aee8366` (#417) only moved it.
- Neither the commit, the tests nor the docs give a rationale.
- The bundled runtime was then Bun 1.3.14. It is now Bun 1.4.2
  (`mise.toml`, `scripts/download-bun.sh`, `docker/Dockerfile`), and ACP runs
  only under that bundled Bun.

Experiment: a `node:http` server with the bridge's exact listener set and a
5 ms probe of the poll's condition (`socket.destroyed || !socket.writable`),
driven by raw `net` sockets. The same script was run on both runtimes.

| Disconnect shape | Bun 1.4.2 | Bun 1.3.14 |
| --- | --- | --- |
| Full close (FIN/destroy) while handler waits | `res.close` + `sock.close` at disconnect; poll no earlier | no event; poll never true |
| Reset (RST) | same as above | no event; poll never true |
| Peer half-close (`end()`) | `res.close` + `sock.close` at the FIN; `sock.end` never fires | no event; poll never true |
| Abort part-way through a body | `req.aborted` + `res.close` | `req.aborted` + `sock.close`; poll ~5 ms later |
| Complete POST, then close | `res.close` + `sock.close` at disconnect | no event; poll never true |
| TCP proxy tears down its upstream | `res.close` + `sock.close` at disconnect | no event; poll never true |
| Close after response started streaming | `res.close` + `sock.close` at disconnect | no event; poll never true |
| Close immediately after writing the request | events within ~1 ms; socket not yet destroyed when the handler ran | no event; poll never true |
| Completed response (keep-alive or `Connection: close`) | events fire only after `writableEnded` (ignored) | same |
| Keep-alive reuse | first request's listeners do not fire for the second; closing the socket later only reports ended responses | same |

`req.close` fires when the request body ends on both runtimes. It is not a
disconnect signal and was never used.

- On 1.4.2 the events cover every shape, and in every case the poll's
  condition became true no earlier than an event.
- On 1.3.14 the poll covered nothing the events missed. It never fired where
  the events were silent. So the poll was never a working fallback, and the
  events are complete on the supported runtime.

Decision: removed, not consolidated.

- `bridges/acp-bridge/src/acp-client-disconnect.ts` (`watchClientDisconnect`)
  keeps the four listeners.
- It adds a synchronous check for a socket that closed before the handler ran,
  because such a socket has no events left to deliver.
- It notifies at most once, ignores anything after the response has ended,
  and its stop function removes every listener when the route settles, on
  success or failure. A keep-alive socket therefore does not accumulate
  listeners.
- Read cancellation is unchanged: the signal aborts create, attach, model and
  composer reads. A prompt already accepted is still not cancelled because a
  view disappeared.

Cost removed: 20 timer wakeups per second for each in-flight request. Such
requests last as long as a session create, resume or attach, which is bounded
by the 30 s RPC timeout, or a model or composer read. The total was 20 × N/s
for N concurrent ones.

Latency is equal or better. The events fire at the disconnect; the poll fired
up to 50 ms after it.

`acp-client-disconnect.test.ts` asserts all of the above over real sockets,
and that no interval is armed per request. Mutation check: dropping the
`close` listeners and the synchronous check fails 9 of the 10 cases. The
partial-body case still passes through `aborted`.

### Reconnect policy (`3419f9d2`)

`packages/protocol/src/reconnect-backoff.ts` is policy only: no timers and no
I/O. Randomness and the clock are injected.

- `reconnectDelayMs(policy, consecutiveFailures, random)` computes
  `min(maxDelayMs, initialDelayMs × multiplier^failures)` (multiplier 2 by
  default), then draws from `[base × (1 − jitterRatio), base]`. The default
  `jitterRatio` is 0.5 (equal jitter). The first retry is therefore never
  slower than `initialDelayMs`, and hostile inputs are clamped.
- `ReconnectBackoff` wraps it for one owner:
  - `connected()` records when the connection came up.
  - `nextDelayMs()` returns the delay and counts one more consecutive failure.
    It resets the count only if the connection that just ended stayed up for
    at least `healthyAfterMs`, so a connection that closes immediately still
    climbs the ladder.
  - `reset()` clears the count.
- It is only for read and stream recovery. It never drives prompt, approval or
  write retries.

Adopted:

| Owner | First retry | Cap | Healthy after | Reset / cancellation | Replay preserved |
| --- | --- | --- | --- | --- | --- |
| OpenCode event monitor (`opencode-provider.ts` `monitorRequests`) | `monitorRetryMs` (1 s) | 30× first retry (30 s) or `monitorRetryMaxMs` | 30 s | One sequential wait; `dispose()` aborts it | Gap marking + snapshot reconciliation on every reconnect; nothing resubmitted; auto-answer only rejects |
| Web gateway main stream (`web-gateway.ts` `scheduleReconnect`) | `eventReconnectDelayMs` (2 s) | 8× first retry (16 s) or `eventReconnectMaxDelayMs` | 30 s | One `reconnectTimer`; reset when the last main listener leaves | Every attempt resumes from `since=mainEventCursor`; connected/reconcile frames unchanged |

Tests:

- `reconnect-backoff.test.ts`
- `apps/backend/src/core/opencode-provider-reconnect.test.ts`:
  - the ladder to the cap
  - failed subscribes
  - reset after a healthy stream
  - snapshot reconciliation without resubmission
  - dispose cancelling the pending wait
  - never more than one pending wait
- `apps/web/src/lib/native/web-gateway-reconnect.test.ts`:
  - the ladder with one timer
  - the first retry within its configured delay
  - the cursor on every backed-off attempt
  - removing the last listener cancelling the retry and resetting the ladder
- `opencode-provider-dispose.test.ts`, which uses the real SDK client, still
  passes.

Inventory of the remaining transports. These were not changed; each one is
recorded here for a later, separately testable change.

| Owner | Current schedule | Reset | Cap | Cancellation | Decision |
| --- | --- | --- | --- | --- | --- |
| Terminal WebSocket (`terminal-websocket-client.ts` `fallbackAndReconnect`, `scheduleSubscribe`) | `min(10 s, 500 ms × 2^min(n,5))`, no jitter | on `ready` / `subscribed` | none | one socket timer; one per-channel timer; cleared on dispose/visibility/idle | Deferred: already exponential; jitter needs an injected random and changes exact-delay tests (`terminal-websocket-client.test.ts` "backs off repeatedly denied subscriptions") |
| Gateway terminal fallbacks (shared EventSource, per-stream fetch) | constant `eventReconnectDelayMs` | n/a | none | one timer per stream | Deferred: secondary; each reopen forces a desync snapshot |
| Gateway browser `EventSource` (cookie mode) | browser-owned while CONNECTING; our timer only on CLOSED | — | — | — | CLOSED path now shares the main-stream backoff; browser retry untouched |
| Native chat store ladder (`createNativeChatStore.ts`) | `reconnectAttempts` ladder | — | — | — | No production driver (only tests call it); leave to a cleanup that deletes it |
| Codex `ProcessSupervisor.startWithRetry` | `[250…10 000] ms` with equal jitter; circuit after 5 failures/60 s | per start | circuit | `startPromise` coalesces | Left: already jittered. Noted: breaker never resets; backoff `sleep` is not cancellable |
| ACP `requestPromptWithRetriableProviderRetries` | 1 s × 2^(n−1), 3 retries | — | 3 | ownership re-checked | Left: re-sends a continuation prompt, so not a read retry |
| Claude, Pi, Cursor | no transport reconnect loops | — | — | — | n/a |

Abort-consumer audit:

- Every in-scope consumer owns its rejection:
  - OpenCode: `startup` has a `.catch`, as do the retry wait and each request
    task.
  - Gateway: `reader.cancel().catch(...)`, and fetch errors are caught inside
    the stream task.
  - Terminal WebSocket: uses no `AbortController`.
- ACP's `controller.abort()` reaches `raceAbort` and child RPCs. Both reject
  into the route, whose `.catch` owns them.
- Cursor and Pi: the abort of the request controller reaches read routes only.
  The idle-detach promises have `.catch`.
- The lifecycle's `requestExit` never rejects.
- The Codex stdout loop is untouched.

### Heartbeats and maintenance

Unchanged, deliberately:

- gateway `KEEPALIVE_MS` 25 s (`gateway-support-core.ts`), which also advances
  the cursor
- Claude SSE `KEEPALIVE_INTERVAL_MS` 30 s
- Codex SSE: checks every 5 s and sends at 5 s while active, 30 s while idle
- the one-minute Cursor/Pi idle sweeps and their ten-minute threshold (now
  owned and disposable)
- Codex/Claude five-minute cleanups, and six-hour log retention
- lock heartbeats and approval/auth expiry

No transport measurement exists yet that would justify changing any of them.

### Checks

Focused, all passing:

- `bridge-lifecycle`, `parent-watchdog` and `reconnect-backoff` tests
- the whole Cursor bridge suite (475 pass, 4 skip) and the whole Pi bridge suite
- Pi `http.test.ts`, run with the new lifecycle
- `acp-client-disconnect.test.ts`
- the OpenCode provider suites (248 tests, including the real-client dispose
  test)
- `web-gateway.test.ts`, `web-gateway-reconnect.test.ts` and
  `terminal-websocket-client.test.ts`
- typechecks for backend, web, protocol, Cursor and Pi

Full ACP bridge suite:

- The unmodified server passed 409/409 in 103.9 s.
- With this change it gave 408/1 in 202.8 s, under load average 35–41 from
  concurrent agents.
- The one failure is registered as flaky case 0161. It failed and passed alone
  at the same rate on the unmodified server.
- ACP integration tests must be run with the ambient `ORKESTRATOR_AGENT_MCP_*`
  and `ORKESTRATOR_PARENT_PID` unset when started from inside an Orkestrator
  agent environment. See the 0034 recurrence note; the harness does not scrub
  them.

Repository-wide:

- `mise run test:logged -- --name check -- mise run check` passed: format,
  lint and typecheck.
- `mise run test:changed` (ambient agent variables unset) passed for the
  Cursor (475), Pi (366), Claude (1,008) and Codex (1,834) bridges and the
  Codex protocol lockfile. It failed only in these load-sensitive cases, and
  every owning file passed when rerun alone:
  - acp-http "reaps a session process…" (flaky case 0034, recurrence noted)
  - two root `backend-owned diff statistics` scans (new case 0162)
  - four desktop `isolated-browser` runner cases (new case 0163)
- None of those cases touch code changed here. The host load average was
  30–41 throughout.
- The complete `mise run test` was not run separately.

### Deferrals and untested constraints

- No before/after production measurements:
  - Steps 01/02 (metrics and scheduler) had not landed.
  - The ACP reduction is derived: 20 wakeups/s per in-flight request.
  - Reconnect-storm reduction is shown only by the deterministic ladder tests,
    not by an outage workload.
- The terminal WebSocket jitter, the gateway terminal fallbacks and the Codex
  supervisor breaker reset are not changed (see the inventory).
- Pending subscription and channel bounds are not changed. The existing bounds
  are untouched.
- The ACP test harness does not scrub ambient `ORKESTRATOR_*` agent variables.
  Not fixed here; recorded in flaky case 0034.
- The cross-environment and restart scenarios in the plan index were not run:
  bridge restart at a durable boundary, and two clients with one
  disconnected. No isolated application profile was used for this step.
