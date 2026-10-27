# Remote client bandwidth

Checked against `main` at `863b5782` (2026-10-27).

Remote and constrained clients (a browser over the tailnet, the hosted web
client, iOS) pay for every byte and request the backend sends them. Two
independent levers share one measurement baseline: wire encoding (gzip and
terminal transport choice) and client read scheduling (the data-saving
preference). Neither may trade away incremental delivery, exact terminal
recovery or responsive approvals.

Done on 2026-10-27: a client-local data-saving preference that slows only the
requesting client's background reads, an in-process baseline harness with a
first matrix (normal and constrained links, several healthy clients and one
slow client), and tests for incremental `on`-mode streaming, encoding
negotiation, replay, keepalives and compressor release. No default changed.
What is left needs the real remote route: the same matrix through the
Tailscale listener and Tailscale Serve, the data-saving byte measurement in a
real browser, and the browser QA in the acceptance criteria.

## Current state

- Gateway compression modes are `off`, `body` and `on`
  (`GATEWAY_COMPRESSION_MODES` in `apps/backend/src/gateway-support-core.ts`),
  set by `--compression` or `ORKESTRATOR_GATEWAY_COMPRESSION`
  (`apps/backend/src/options.ts`). `resolveGatewayCompressionMode` defaults to
  `body`: eligible ordinary responses are compressed and SSE is not. The
  control listener is always `off` (`compressionModeForListener`).
  `../../architecture/remote-gateway.md` now documents all three modes, the
  streaming ceiling, the control listener and the opt-in terminal WebSocket.
- SSE gzip runs only in `on` mode. Direct `/events` streams use
  `GzipEventClientWriter` (`gateway-support-extra.ts`, wired in
  `gateway-handlers.ts`); proxied streams use `createSseGzipCompressor`
  (`gateway-proxy.ts`). Both flush synchronously. Streaming gzip contexts share
  a ceiling of `MAX_CONCURRENT_STREAMING_COMPRESSIONS` (8); when it is full the
  stream continues with identity encoding. A browser holds two event streams
  (main and one shared terminal stream), so four browsers fill the pool.
- `apps/backend/tests/gateway-streaming-compression.test.ts` covers, in `on`
  mode: each small frame flushed while the stream stays open (direct and
  proxied), one encoding only, identity plus `Vary: Accept-Encoding` for
  clients that do not negotiate gzip (none, `identity`, `gzip;q=0`, `br`),
  replay after a compressed reconnect, decodable keepalives over a long idle
  stream, a disconnect mid-burst, and compressor release on credential
  rotation and gateway stop.
- Gateway metrics separate serialised/source bytes from encoded SSE bytes, and
  report streaming gzip totals, terminal WebSocket payload bytes, framed bytes,
  ACKs, queue peaks, desyncs and lifecycle counts.
- Terminal WebSocket transport (`TerminalWebSocketGateway`,
  `apps/backend/src/terminal-websocket-server.ts`) is opt-in through the
  `terminalTransport` option or the `orkestrator-terminal-transport`
  localStorage key, has socket and channel limits, and uses no message
  compression. Output ACKs are cumulative and coalesced for 50 ms.
- `apps/backend/scripts/remote-bandwidth-baseline.ts` runs the real gateway in
  process (temporary data directory, ephemeral `127.0.0.1` port, random token
  never printed) against synthetic workloads and reports aggregate bytes,
  latency, CPU, heap and gauges. `--rate-kbps`/`--latency-ms` put each client
  behind a userspace link limiter. See "Measurements" below.
- Client reads go through `apps/web/src/lib/read-coordinator.ts` and
  `useCoordinatedRead`. A resume (visibility, focus, page-show) now restarts
  every quiet backoff: a backed-off key reads at once if its base cadence is
  overdue, otherwise it continues on its base grid.
- Data saving (new): `uiStore.dataSaving`, persisted with the client's UI
  state, toggled in Settings > General (`DataSavingSetting.tsx`) and fed to the
  coordinator by `lib/data-saving.ts` (`setDataSaving`). A read's demand may
  carry a `dataSaving` variant; trial values are in
  `apps/web/src/lib/data-saving-policy.ts`: native running/blocked/cancelling/
  recovering views 1 s (500 ms otherwise), the Files panel backs off through
  10, 15 and 30 s on a watched worktree (10 s on an unwatched target), a
  running reviewer tab backs off through 8, 15 and 30 s. Invalidations,
  explicit refreshes, resume and reconnect are never slowed; announced Files
  revisions, mutations, reviewer checkpoints and status changes call
  `noteActivity()` to restore the base cadence. Idle native views keep their
  existing quiet backoff (all six providers qualify, Claude and Codex only
  while `turn.quietObservation`).
- Only the selected environment's `TerminalContainer` is mounted
  (`App.tsx`); other environments hold no terminal subscriptions. Hidden
  terminals are background tabs of the open environment, and they stay
  subscribed (decision D5).
- The backend's activity sweep reads HTTP bridges through
  `POST /sessions/activity` in chunks of at most 64 ids
  (`packages/protocol/src/session-activity-batch.ts`).
- The staged plan and its decision-record template are
  [`plans/stream-efficience.md`](../../../plans/stream-efficience.md).

## Measurements

### In-process baseline, 2026-10-27

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

### Constrained link, 2026-10-27

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

### Data-saving read budget

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
request counts; bytes per request need a real client (see "Needs
verification").

## Outstanding work

### Qualification

- Run the matrix above through the supported remote route at normal and
  constrained bandwidth: the harness's in-process gateway cannot sit behind
  Tailscale. Either point the same client side at a real gateway on another
  machine (an isolated profile with synthetic terminals), or put a
  disposable gateway behind `tailscale serve`. Record the Phase 2 fields, and
  confirm whether Serve buffers or re-encodes SSE.
- Measure encoded bytes of negotiated transcript part patches and of several
  remote clients on one session (only decoded bytes were measured). The
  harness's agent-event workload is synthetic, not real part patches.
- Data saving: measure bytes and requests per minute in a real browser with
  the mode off and on (running agent, open Files panel, running reviewer),
  and check the approval and completion budgets as p50/p95 with it on.
- Isolated browser QA from the acceptance criteria: backgrounding, screen
  lock and resume, tab switches, two clients with different preferences,
  reload, throttled and disconnected links.

### Code

1. Change at most one default per decision. None changed (D1); revisit with
   the remote baseline using the decision-record template.
2. Done: client-local data-saving preference (D2, D3).
3. Done: 1 s responsive cadence and quiet backoff for the Files panel and
   reviewer tab under data saving, reset on user action, invalidation,
   reconnect and return (D4).
4. Done: approvals, completion, errors and queue state still arrive through
   invalidations that read at once; data saving only slows backstop polls.
5. Decided: hidden terminal subscriptions stay attached (D5).
6. Deferred: `permessage-deflate` for the terminal WebSocket is needed only if
   Phase 3 chooses the WebSocket for bulk output; the in-process data says it
   would be required in that case (bulk output is about 7.5 times larger than
   `on` SSE). Decide the direction with the remote baseline first (D6).

### Acceptance criteria

- Compression never delays an approval or completion event indefinitely,
  loses authoritative state, or encodes twice. (Covered in process: every
  frame flushes on its own, one encoding.)
- Unsupported negotiation and codec failures have tested, bounded behaviour.
  (Covered: identity for non-gzip clients, codec failure, pool saturation.)
- Terminal output matches the exact snapshot after backpressure and reconnect.
- `body` mode and HTTP/SSE stay available as rollback during any opt-in trial.
- The data-saving preference affects only the requesting client; two clients
  with different preferences keep their own freshness. (Unit-covered: two
  coordinators keep their own cadence; live check owed.)
- Returning or reconnecting restores exact state, including pending approvals,
  errors, queued prompts and parked dispatch controls.
- Offline periods and missed invalidations recover through authoritative reads
  with bounded retries and no prompt resubmission.
- Idle and active bytes and requests improve measurably against the baseline
  with the mode off. (Requests: see the budget table; bytes owed.)
- Completion and approval visibility stay within an explicitly chosen budget,
  reported as p50 and p95. (Budget chosen in D4; live p50/p95 owed.)
- Isolated browser QA covers backgrounding, screen lock and resume, tab
  switches, two clients with different preferences, reload, and throttled or
  disconnected links.
- Metrics and artifacts hold no terminal content, prompts, credentials,
  attachment data or file contents. (The harness emits aggregates and
  synthetic workload ids only.)

## Constraints and rationale

- The staged plan's invariants hold for every experiment: snapshots stay
  authoritative, missed terminal output produces a desync and exact snapshot
  recovery, authoritative events are never silently dropped, terminal output
  is dropped only at a bounded backpressure threshold, every buffer, socket,
  channel and compressor is bounded, and reconnect, replay, generation and
  revision ordering are unchanged.
- Compression and browser work never block a provider or app-server stdout
  loop. Compressor buffers count against existing slow-consumer limits rather
  than moving backpressure onto the provider's reader.
- Reducing repeated source work comes before tuning wire size.
- Benefit is shown in encoded or WebSocket-framed bytes, not inferred from
  serialised payload size.
- Keep a recovery poll until a provider's event coverage is demonstrated. An
  event-only design is an experiment, not a replacement.
- One client's preference never changes a shared backend's cadence for other
  clients.
- This work authorises no production configuration change on its own.

## Assumptions and decisions

Decisions made on 2026-10-27 for this round, with the options weighed.

- **D1. Defaults.**
  - Options: (a) make `on` the default; (b) make the terminal WebSocket the
    default; (c) change nothing until the remote route is measured.
  - Choice: (c).
  - Why: the in-process data favours `on` for bytes, but the plan requires
    the supported remote route before promotion, Tailscale Serve's handling
    of SSE is unknown, and the eight-context pool is already full with three
    browsers plus one slow client, so a default `on` would quietly decline
    for the fifth browser. The WebSocket alone does not meet a bandwidth
    target for bulk output. The constrained run makes the case for `on`
    stronger (bulk output stays at link latency instead of seconds behind),
    which is exactly why the real route has to confirm it.
  - Pros: no unmeasured production change; `body` and HTTP/SSE stay the
    rollback. Cons: remote users keep paying uncompressed SSE until then.
- **D2. Where the preference lives.**
  - Options: (a) the persisted `uiStore`; (b) a new device-wide store; (c)
    backend config.
  - Choice: (a).
  - Why: it is client-local by construction (localStorage) and the todo named
    it. In Electron `uiStore` presentation state is kept per machine window,
    so the preference is per machine there, which suits a remote machine
    reached over a slow link while Local stays fast. (c) would change other
    clients.
  - Pros: no backend change, no new storage key. Cons: an Electron user sets
    it per machine; a browser per origin.
- **D3. Where the switch is shown.**
  - Options: (a) Settings > Machines "This device" (`ClientOptions`); (b)
    Settings > General.
  - Choice: (b), labelled "Applies to this device only".
  - Why: `ClientOptions` renders only in Electron (it needs
    `window.orkestrator.connections`), and the remote browser and hosted
    client are the main users.
  - Pros: visible on every client. Cons: General otherwise shows machine
    settings, so the wording has to say it is device-local.
- **D4. Trial values and budget.**
  - Options: slow everything uniformly; or slow only backstops whose changes
    are announced, more where coverage is complete.
  - Choice: the second, with the values in `data-saving-policy.ts`. Native
    running backstop 1 s (approval ≤ 2 s and completion ≤ 3 s budgets
    unchanged, since both arrive as invalidations); idle native unchanged;
    Files panel 10/15/30 s when watched, 10 s when unwatched (budget ≤ 2 s
    after an announced revision, ≤ 11 s unwatched, explicit ≤ 1 s); reviewer
    8/15/30 s with checkpoints immediate. Recorded in
    `../../architecture/recurring-work.md`.
  - Why: keeps safety and responsiveness on the event path and leaves a
    bounded recovery poll everywhere, as the constraints require.
  - Pros: 50 to 85 % fewer scheduled reads where it applies. Cons: an
    unwatched Files panel can lag by up to ~10 s for that client; a manual
    reviewer refresh that changes nothing does not reset its backoff.
- **D4a. Return restarts backoff for every client.**
  - Options: restart quiet backoff on resume only with data saving on, or
    always.
  - Choice: always. The coordinator's resume reconcile now resets every
    quiet streak and reads a key whose base cadence is overdue.
  - Why: `event-snapshot-recovery.md` already promised that a visible
    reconcile returns a native view to 1.5 s; the code only did so when the
    backed-off interval was overdue.
  - Pros: one rule, matches the documented contract. Cons: a focus event can
    now cost one read for a view that had backed off.
- **D5. Hidden terminal subscriptions.**
  - Options: (a) detach hidden tabs' output while data saving is on and
    reconcile from the state snapshot on return; (b) leave them attached.
  - Choice: (b).
  - Why: the item allows detaching only where recovery is exact. The state
    snapshot keeps the current screen exactly but halves scrollback to fit its
    byte target (`serializedState` in `apps/backend/src/core/terminal-history.ts`),
    so a detached tab would come back with less history than it had. Other
    environments' terminals are already unmounted.
  - Pros: no scrollback loss, no change to the terminal recovery path. Cons:
    background tabs of the open environment still stream.
- **D6. WebSocket compression.**
  - Options: (a) prototype `permessage-deflate` now; (b) wait for the
    direction decision.
  - Choice: (b).
  - Why: it matters only if the WebSocket becomes the bulk transport; with
    `on` SSE the bytes are already compressed. The backend runs `ws` under
    Bun, whose compression support behind `handleUpgrade` needs checking
    first.
  - Pros: no unused code path. Cons: if the WebSocket is chosen, this becomes
    a prerequisite.
- **D7. Harness location and scope.**
  - Options: a root `scripts/` file, or `apps/backend/scripts/`; real
    `ws` client or a raw RFC 6455 client.
  - Choice: `apps/backend/scripts/remote-bandwidth-baseline.ts` with a raw
    client.
  - Why: it imports the gateway directly; Bun's `ws` client hides the socket,
    so wire bytes and a truly non-reading slow client need the raw one. Each
    browser is modelled as main SSE plus one shared terminal stream, as
    `web-gateway.ts` does. Reconnect/replay is covered by the test suite, not
    the matrix.
  - Pros: exact wire bytes, no real data or ports. Cons: not the remote route;
    CPU includes the clients.

## Needs verification

- The remote route. `../../architecture/remote-gateway.md` supports the
  Tailscale listener directly and through Tailscale Serve (HTTPS, used by the
  hosted client). Confirm whether Serve buffers or re-encodes SSE before
  treating it as the proxied case. Not run: this machine runs the live
  Orkestrator and no disposable tailnet node was available.
- Phase 1 exit criteria. Now covered: compressor leases released on close,
  codec failure, mid-burst disconnect, gateway stop and credential rotation
  (`gateway-streaming-compression.test.ts`, `gateway-events.test.ts`);
  terminal sockets closed on rotation and stop and channel gauges back to zero
  after close (`gateway-events.test.ts`). Not asserted anywhere: that no
  keepalive or WebSocket timer and no queued bytes survive gateway stop.
- Data saving in a real browser: bytes per minute with the mode off and on,
  approval and completion p50/p95, and two clients with different
  preferences.

## Related

- [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md):
  qualifying Claude and Codex for quiet backoff.
- [0051-client-reconnect-and-freshness.md](0051-client-reconnect-and-freshness.md):
  transport disconnect signals and jittered reconnect.
- [0050-transcript-history-efficiency.md](0050-transcript-history-efficiency.md): source
  work and decoded byte reductions.
- [0048-recurring-work-qualification.md](0048-recurring-work-qualification.md): latency
  budgets and live client QA.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md):
  shared prerequisites for remote and iOS runs.
- `../architecture/event-snapshot-recovery.md` (read coordinator, quiet
  backoff contract).

## Replaces

- `docs/todo/remote-stream-compression.md` (all)
- `docs/todo/remote-client-data-saving-mode.md` (all; its claim that visible
  idle reads stay at 1,500 ms is corrected above)
- `docs/improvements/efficiency/README.md` (compression and data-saving
  guidance)
- `docs/improvements/efficiency/frontend-and-workflows.md` (E11 and the remote
  gateway row of "Areas inspected")
- `docs/improvements/efficiency/validation.md` (remote-path rows)
- `docs/improvements/efficiency/plan/01-baselines-and-instrumentation.md`
  (remote baseline row)
- `docs/improvements/efficiency/plan/14-part-level-deltas.md` (encoded and
  multi-client bytes)
- `docs/improvements/efficiency/plan/17-read-scheduling-and-activity.md`
  (scheduling shipped; preference and backoff left)
- `docs/improvements/efficiency/plan/19-integration-and-rollout.md` (remote
  proxy and compression rows)
- `docs/improvements/recurring-processes/plan/00-index.md` (data-saving
  deferral and the compression relationship)
- `docs/improvements/recurring-processes/plan/06-client-read-coordination.md`
  (task 9, the data-saving preference)
