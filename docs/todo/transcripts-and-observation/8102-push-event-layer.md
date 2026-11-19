# A general push event layer, starting with the live agent view

From to-do 1202 (retired 2026-11-10) task 4 and to-do 6680 (retired) task 2.
A visible running agent tab still polls: about 2.2 requests a second per
viewer, each an `unchanged` answer of about 1.5 KB when nothing moved
(measured again on 2026-11-15, below). On 2026-11-14 the user (maintainer)
chose to build push, scoped as a general event layer that many kinds of data
flow over, with the bridge state revision from 6680 as its change signal.

## Task analysis

Analysed 2026-11-19 against `main` at `5e9835d0a`. Phase 1 (2026-11-15) wrote
the design and the polling baseline. On 2026-11-19 the user's ticket
("Push live updates efficiently with performance budgets") asked for the
layer to be built, which answers the design review that tasks 2 to 5 waited
on. The layer's core and the `native-session` topic are built (task 3) and
the living doc is [push-events.md](../../architecture/push-events.md)
(task 5). A shared backend observer reconciles each subscribed session.
Qualified idle Claude and Codex bridges can wake it through their existing
observation stream and content revision. Task 2 remains open for full bridge
state revision coverage. See [Assumptions and decisions](#assumptions-and-decisions).

### Tasks

1. **Design and baseline**: write the layer's design and take the before-measurement per the efficiency rules, before any code. Status: done (2026-11-15).
2. **Bridge state revision**: every bridge moves a revision on every state change and answers a conditional state read `unchanged`; Pi sends its composer and model list only when they changed. Status: open.
3. **The layer's core and the live agent view over push**: subscriptions on the existing event stream, the `native-session` topic, the recovery poll, and removing the 500 ms poll while push is healthy. Status: done (2026-11-19).
4. **Further surfaces**: measure the other live surfaces' request volume, then move them onto the layer one at a time, highest volume first. Status: open.
5. **Promote the design to a living doc**: [push-events.md](../../architecture/push-events.md), linked from `event-snapshot-recovery.md` and `recurring-work.md`. Status: done (2026-11-19); this file stays until tasks 2, 4, 6 and 7 are done.
6. **Node subscription controller (D10)**: let a window subscribe to a node it reaches through a command node, through a controller on the command node that unions and reference-counts downstream sets. Status: open.
7. **Measure the result against the baseline**: repeat baselines A and B on the new commit, one and two viewers, and the reconnect and inactive-view cases. Status: open.

### 1. Design and baseline

**Problem.** Each live surface has its own polling or stream, so every new
one adds requests, and none shares reconnect, resume or back-pressure. A
structural change of this kind needs a baseline before any code
([efficiency-harness.md](../../development/efficiency-harness.md#rules-for-efficiency-changes)).

**Context.** The numbers the decision was made on (1202 task 4, 2026-11-04,
and 6680): a visible running Claude tab sent about 2.1 requests a second, one
combined read (`get_native_agent_live_update`) per 500 ms round; an
`unchanged` answer was about 1.6 KB on the wire. Today's cadence is C01 in
[recurring-work.md](../../architecture/recurring-work.md). The substrate the
layer builds on is described in
[event-snapshot-recovery.md](../../architecture/event-snapshot-recovery.md)
and summarised under [What exists](#d2-what-exists-to-build-on).

**Investigation.** Done on 2026-11-15. The baseline was taken with the two
live specs the efficiency rules name for transport changes, both on isolated
`dev:test` profiles on arktech-mini (macOS, Apple silicon) at `a8b89f154`
plus this change's spec edits:

- `e2e/agent-testing/agent-tab-requests-live.spec.ts`, the `running-quiet`
  workload this file named, with real Claude turns (Haiku) on a profile with
  the host's Claude login. The spec gained a `running-quiet-two-viewers`
  case: a second browser context opens the same tab during the same kind of
  foreground wait.
- `e2e/agent-testing/conditional-reads-live.spec.ts`, credential-free, a
  loopback model streaming a scripted turn into the real Claude CLI and the
  real Codex app-server, measured with one viewer, two viewers and idle, and
  counting every bridge request by route. Its toolchain lookup read
  `/proc/<pid>/cmdline`, which macOS lacks; it now falls back to `ps` there.

The figures, what they show and how to repeat them are under
[Current state](#current-state). The design answers every question this task
listed: transport, framing and topics, ordering, resume and gap recovery,
back-pressure, authentication over the gateway and node links, bridge
revisions, the recovery poll, migration order, test strategy and open
questions.

**Decisions.**

- **Where does the design draft live until it is built?**
  - **In this file, under Outstanding work (chosen; this task's own
    instruction was "draft it in this file first").**
    - Pros: one place for the decision, the plan and the evidence; the
      `docs/` layout reserves `architecture/` for shipped behaviour.
    - Cons: a long to-do file until task 5 moves it.
  - **A new `docs/architecture/push-events.md` now.**
    - Pros: the final location.
    - Cons: it would describe behaviour that does not exist, which the
      layout forbids.
- **Which baseline?**
  - **Both live specs, one and two viewers, Claude real and loopback, Codex
    loopback (chosen).**
    - Pros: the named `running-quiet` workload (where push saves the most)
      plus per-route bridge counts while streaming (where push must not cost
      more); repeatable with the same spec files on the new commit.
    - Cons: the real-Claude case is billed (a few Haiku turns) and has no
      bridge-side counters.
  - **The function-level efficiency harness alone.**
    - Pros: deterministic, free.
    - Cons: it measures no transport, reconnect or viewer count.

### 2. Bridge state revision

**Problem.** The backend can only learn that a bridge's session state changed
by reading it, and each read is five bridge requests. On 2026-11-15 Claude's
state body repeated on 36 of 40 streaming polls with one viewer and 76 of 80
with two; Pi's `/status` sends its whole composer on every poll (130 KB with
300 models on the fake bridge, 6680).

**Context.** 6680 (retired) task 2 and task 3's composer analysis
(`git show 1ac78be57^:docs/todo/transcripts-and-observation/6680-conditional-reads-and-deltas-measured.md`).
What each bridge exposes today: Claude's `GET /session/:id` carries only
`commandRevision`, and `/activity` an opaque `contentRevision`; Codex's
`/session/:id/status` carries `messageRevision`, `contentEpoch`,
`engineGeneration` and `commandRevision`; the ACP, Cursor and Pi status
bodies carry a `revision`. None answers a conditional state read. Codex's
`/status` body changed on 39 of 40 streaming polls, so a revision spares
Codex little on its own; its value is as the layer's change signal. The
design for this task is [D7](#d7-bridge-revisions-the-change-signal). Bridge
rules: [`bridges/AGENTS.md`](../../../bridges/AGENTS.md).

**Investigation.** Designed (D7); not built. Waits on the user's review.

**Decisions.**

- **How is the revision exposed?**
  - **On the existing `?observe=1` wakeup stream and as a `knownToken` the
    state route answers `unchanged` to (recommended).**
    - Pros: reuses the content-free observer the backend already keeps
      connected; the conditional read keeps working when a wakeup is missed.
    - Cons: every state mutation site in five bridges must move it, with a
      test per bridge that a change without a move fails.
  - **A new bridge push route.**
    - Pros: purpose-built.
    - Cons: a second stream per bridge.
- **Pi's composer and model list?**
  - **Send them only when their own revision changed (recommended, the
    user's decision).**
    - Pros: removes the largest repeated body.
    - Cons: the backend must cache the last composer per session.
- **Do the side routes fold into the revision?**
  - **Yes: questions, plan approvals, interactions, approvals and Codex's
    `/config` move the same state revision, so one `unchanged` answer
    replaces the four state and side-route requests (recommended).**
    - Pros: the state part of a quiet poll becomes one small request
      instead of four, so a poll with nothing new costs two bridge requests
      instead of five.
    - Cons: every side route's mutation sites join the per-bridge test.
  - **Revision the main state body only.**
    - Pros: fewer sites.
    - Cons: the three side-route requests per poll stay.
- **What about the transcript read?** It is the fifth request of every poll
  in baseline B and is not covered by the state revision: the transcript
  keeps its own content revision and can change while the state does not.
  This task leaves it in place, so the target is five requests down to two
  for a poll whose state is unchanged. The poll's transcript read goes in
  task 3, when the live view reads the `transcript` part only after a frame
  names it (D9 step 3). Measure this task with separate counters for state
  and transcript requests (spec B already counts by route).

### 3. The layer's core and the live agent view over push

**Problem.** The live agent view is the busiest poller and the first consumer
the decision names: 2.2 requests a second per viewer while nothing moves.

**Context.** `useNativeAgentSession.ts`, `native-session-read-policy.ts`,
`native-session-shared-reads.ts` (C01). The design is D3 to D6 and D8; the
migration is D9 steps 2 and 3. The recovery poll stays as a safety net only.

**Investigation.** Built 2026-11-19 (see [push-events.md](../../architecture/push-events.md)).
The 500 ms and 1.5 s rounds and the quiet ladder are kept as the fallback
cadence while push is unhealthy rather than removed, which the "never worse
than today" rule of D8 needs. Unit, contract, gateway and hook tests cover it;
the live measurement is task 7.

**Decisions.**

- **How slow is the safety-net poll?**
  - **Long (30 s) while the channel is healthy, back to today's cadence while
    it is down or desynced (recommended).**
    - Pros: a broken channel degrades to today's behaviour, never worse.
    - Cons: two modes to test.
  - **No poll while the channel is healthy.**
    - Pros: fewest requests.
    - Cons: a silent bug in the layer would freeze a view; the decision
      keeps a recovery poll.
- **The other decisions of this task** are D3 to D6 and D8 below.

### 4. Further surfaces

**Problem.** Pipelines, agent mail, tickets and other live surfaces poll or
stream separately.

**Context.** Their cadences are in
[recurring-work.md](../../architecture/recurring-work.md); candidates are in
D9 step 4.

**Investigation.** Depends on 3. Each surface is its own change with its own
before and after numbers. The first step is a measurement of every renderer
command's request rate on a busy profile (the gateway's
`/__orkestrator/metrics` command buckets), so the order rests on numbers.

**Decisions.**

- **Order?**
  - **By measured request volume, highest first (recommended).**
    - Pros: the biggest saving lands first.
    - Cons: needs the numbers first.
  - **By how simple the surface is.**
    - Pros: quick wins.
    - Cons: may move surfaces that cost little.

### 5. Promote the design to a living doc

**Problem.** This file holds a design; once built it has to become the
living description of the layer.

**Context.** `docs/architecture/` holds shipped behaviour only
([docs/README.md](../../README.md)).

**Investigation.** Depends on 3.

**Decisions.**

- **Where?**
  - **A new `docs/architecture/push-events.md`, with
    `event-snapshot-recovery.md` gaining a row in its sequence table and a
    pointer (recommended).**
    - Pros: one doc for the layer, the existing recovery contract stays
      where readers already look.
    - Cons: two docs to keep in step.
  - **A section of `event-snapshot-recovery.md`.**
    - Pros: one file.
    - Cons: that file is already long and per-view.

### 6. Node subscription controller (D10)

**Problem.** A window's view of a session on another node, reached through
its command node's relay, gets no push offer on the relayed stream, so it
keeps polling.

**Context.** D10 below; `apps/backend/src/core/nodes/node-event-relay.ts`
shares one leaf stream per node across every window, which is why a window
must not subscribe on the leaf directly.

**Investigation.** Not built. The client already treats a stream without an
offer as unavailable, so nothing breaks meanwhile.

**Decisions.**

- **Who owns the leaf subscription?** As D10: a controller on the command
  node that unions and reference-counts downstream sets (recommended); the
  alternative of a leaf stream per window is recorded there.

### 7. Measure the result against the baseline

**Problem.** The acceptance numbers (at least 90% fewer recurring requests
per viewer while quiet; no doubling of bridge reads for a second viewer;
p95 observation latency under 250 ms on a local fixture) need the live
specs that took the baseline.

**Context.** [How to repeat it](#the-polling-baseline-2026-11-15). Push
metrics are in `/__orkestrator/metrics` under `push`.

**Investigation.** Not run. The unit and gateway tests show a quiet running
view sends no reads but the 30 s recovery poll and that two viewers share one
observer read per round; that is not a measurement.

**Decisions.**

- **Which runs?** Baselines A and B, one and two viewers, plus the reconnect
  and inactive cases already in `agent-tab-requests-live.spec.ts`
  (recommended): the same specs make the comparison direct.

## Current state

### The polling baseline (2026-11-15)

All figures are counts, bytes and milliseconds; no prompt, row content, token
or session id was recorded. Host arktech-mini (macOS, Apple silicon, other
work running), commit `a8b89f154` plus this change's spec edits. Raw results
(git-ignored): `output/agent-testing/push-quiet/agent-tab-requests.json`,
`output/agent-testing/push-baseline-claude/conditional-reads.json` and
`output/agent-testing/push-baseline-codex/conditional-reads-codex.json`.

**A. The named workload: `running-quiet`, real Claude (Haiku), 40 s window**,
one visible tab while the turn waits on a foreground `sleep`, so nothing in
the session moves. "Wire" is what the page measured (headers and bodies);
"answer" is the gateway's response-body total. The two-viewer case ran twice
(the first run's profile was stopped by an unrelated session end after its
measurement was recorded; the second run passed end to end, 186 s).

| Measure | One viewer | Two viewers, run 1 (first / second) | Two viewers, run 2 (first / second) |
| --- | --- | --- | --- |
| Requests | 88 (84 live updates, 4 discovery) | 87 / 88 (84 / 85 live updates, 3 / 3 discovery) | 84 / 83 (83 / 82 live updates, 1 / 1 discovery) |
| Requests a second | 2.20 | 2.17 / 2.20 (4.37 together) | 2.10 / 2.07 (4.17 together) |
| Wire bytes | 228,813 (5.7 KB/s) | 219,830 / 222,065 (11.0 KB/s together) | 196,614 / 194,370 (9.8 KB/s together) |
| Live update answers (gateway) | 84; 126,739 B (1.51 KB each) | 169; 254,467 B (1.51 KB each) | 165; 193,350 B (1.17 KB each) |
| Discovery answers (gateway) | 4; 129,636 B (32.4 KB each) | 6; 194,808 B (32.5 KB each) | 2; 64,464 B (32.2 KB each) |
| Gateway handler time per live update | 2.2 ms mean | 1.5 ms mean | 1.5 ms mean |

A live update request body is 444 B. The same run's reconnect case (page offline 6 s and its event stream cut
during a second running turn) made its first read 57 ms after the page came
back online and showed the turn's answer without a reload.

**B. A streaming turn, loopback model (credential-free), 20 s windows**: 18
rounds of 5 s each at 1.2 KB/s, then idle. Requests are bridge requests per
window; "repeats" are state bodies byte-identical to the session's previous
one.

| Measure | Claude, one viewer | Claude, two viewers | Codex, one viewer | Codex, two viewers |
| --- | --- | --- | --- | --- |
| Renderer live updates per viewer | 40 (transcript `delta` 40, state `unchanged` 36) | 40 each (same split) | 40 (`delta` 39, state `unchanged` 36) | 40 each (`delta` 40, state `unchanged` 36) |
| Renderer bytes per viewer; round trip p50 | 169,721 B; 4 ms | 170,290 / 170,759 B; 4 ms | 138,108 B; 5 ms | 141,330 / 141,770 B; 5–6 ms |
| Bridge state polls; repeated bodies | 40; 36 | 80; 76 | 40; 1 | 80; 17 |
| Bridge requests per state poll | 5: state, `/questions`, `/plan-approvals`, `/interactions`, transcript | 5 | 5: `/status`, `/approvals`, `/interactions`, transcript, `/config` | 5 |
| Bridge transcript reads; snapshots | 40; 40 | 80; 61 | 40; 39 | 80; 63 |
| Transcript decoded / wire bytes | 1,574,907 / 51,246 | 6,598,340 / 147,620 | 1,457,500 / 50,213 | 6,904,394 / 157,835 |
| Mean bridge time: state / transcript | 0.12 / 0.29 ms | 0.09 / 0.29 ms | 0.13 / 0.33 ms (`/config` 0.59 ms) | 0.11 / 0.37 ms |
| Estimated delta / snapshot decoded bytes | 317,587 / 1,574,907 (5.0× smaller) | 465,178 / 6,596,497 (14.2×) | 310,281 / 1,457,404 (4.7×) | 494,292 / 6,902,745 (14.0×) |
| Backend's own: health probes; activity sweeps | 9; 10 | 10; 10 | 9; 10 | 9; 10 |

Idle, 30 s, one viewer: 3 live updates (all `unchanged`) and 2 discovery reads
on both platforms (Claude 64,283 B, Codex 20,481 B), so 3 state polls and 3
transcript reads at the bridge.

**What the baseline shows.**

- **Every viewer is a full poller.** Two viewers cost twice the renderer
  requests and twice the bridge reads: the shared coordinated read
  (`native-session-shared-reads.ts`) joins views inside one page, not
  across clients. Push removes this multiplier while nothing moves.
- **A quiet running turn is all waste.** In A, 84 live updates in 40 s
  answered nothing new; with push, a quiet turn costs the recovery poll
  (about one read in 30 s per viewer).
- **Discovery is up to half of the quiet bytes.** In A, each Claude
  discovery answer was about 32 KB, in every run, so it looks like a whole
  body rather than an `unchanged` answer; the loopback idle windows agree
  (about 30 KB for Claude, 8 KB for Codex). Their number varied from 1 to 4
  per viewer in 40 s against a 30 s backstop. With 4 they carried as many
  bytes as all 84 live updates. To-do
  8151 (retired 2026-11-16; [native-transcripts.md](../../architecture/native-transcripts.md#one-request-per-round))
  found three causes:
  each backstop read found its sections expired and answered `stale` (a new
  view plus a 2 s follow-up), the follow-up carried a moved `fetchedAt`, and
  the two sections the job limit refused made a third. Since 8151 an
  unchanged renewal answers `unchanged`, so a quiet tab's discovery is one
  small answer per 30 s and a renewal reaches this layer (D4) only when a
  view would show something new.
- **Streaming must not get more expensive.** While streaming, nearly every
  round really has a change (transcript `delta` on 39–40 of 40), so push
  saves little there; the throttle in D6 keeps it at or below today's rate.
- **The bridge side is cheap per read but multiplied.** State reads cost
  0.1 ms and transcript reads 0.3 ms at these window sizes, five bridge
  requests a poll, doubled per viewer. Since 6680 the health probes fell
  from two per poll to about one per 2 s and the steer probe is cached.
- **Codex's state body changes on almost every streaming poll** (1 of 40
  repeated), as 6680 found; Claude's almost never (36 of 40 repeated).

**How to repeat it** (on the old commit and the new one, same host):

```bash
# A: real Claude, the host's Claude login
mise run dev:test --profile push-quiet --fixture --headless --credential-source claude --agent-platforms claude
ORKESTRATOR_AGENT_TEST_PROFILE=push-quiet ORKESTRATOR_AGENT_TEST_RUN_ID=push-quiet \
  ORKESTRATOR_AGENT_TEST_LIVE_TAB_REQUESTS=1 \
  mise run test:logged -- --name push-quiet -- bunx playwright test \
  --config e2e/agent-testing/playwright.browser.config.ts agent-tab-requests-live.spec.ts \
  --workers=1 --reporter=line --grep running-quiet

# B: credential-free loopback models (E10_PLATFORM=codex for Codex)
ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile push-baseline \
  --fixture --headless --no-agent-credentials --agent-platforms claude,codex
ORKESTRATOR_AGENT_TEST_PROFILE=push-baseline ORKESTRATOR_AGENT_TEST_RUN_ID=push-baseline-claude \
  ORKESTRATOR_AGENT_TEST_E10_BASELINE=1 \
  mise run test:logged -- --name push-baseline -- bunx playwright test \
  --config e2e/agent-testing/playwright.browser.config.ts conditional-reads-live.spec.ts --workers=1
```

Stop and reset each profile afterwards (`dev:stop`, `dev:reset`).

## Outstanding work

### The design (draft for review)

Status: drafted 2026-11-15; D1 to D6, D8 and D11 are built (2026-11-19) with
the changes recorded under [Assumptions and decisions](#assumptions-and-decisions).
D7 (bridge revisions) is task 2 and D10 (node subscription controller) is
task 6. What was built is described in
[push-events.md](../../architecture/push-events.md).

#### D1. Goals and non-goals

Goals:

- One push channel per client connection carrying many topics, each a
  subscription per topic and key, so a new live surface adds a topic rather
  than a poller.
- A quiet surface costs nothing but a slow recovery poll; a busy one costs
  no more than today's poll.
- Every missed change is detectable and recovered from the authoritative
  read the surface already has (root `AGENTS.md` invariants 3, 4, 6, 7, 8
  and 11).
- One contract for the Electron window, the browser and iOS gateway clients
  and node scopes reached through a command node.

Non-goals:

- Carrying data in frames. Frames are change signals; data stays in the
  existing conditional reads (decision below).
- Replacing terminal output streams, the transcript window contract or the
  bridges' own protocols.
- Backward compatibility: every client and backend updates together (the
  user's 2026-11-14 decision), so a surface's old poll is removed when it
  moves, except the recovery poll.

#### D2. What exists to build on

The layer is mostly a composition of pieces that already hold the
invariants:

- **One authenticated event stream per client**, `GET /__orkestrator/events`
  (SSE), with `id: <generation>:<revision>` frames from a replay ring (2,048
  frames, 2 MiB), resume by `since=` or `Last-Event-ID`, a `gateway.connected`
  frame that echoes the client's cursor, `gateway.reconcile-required` with a
  reason, a 25 s keepalive that also advances filtered streams' cursors, and
  per-client write buffers (1 MiB soft, 8 MiB hard, then the connection is
  destroyed). The browser, iOS and Electron clients share its client core
  (`packages/protocol/src/gateway-event-stream.ts`, contract fixtures in
  `gateway-event-stream-contract-fixtures.ts`), which synthesizes
  `native-event-stream-connected` on a fresh connect or reconcile.
- **Electron** reads the same stream in its main process and forwards events
  over IPC (`orkestrator:event`, `orkestrator:node-event`); local windows by
  default run the renderer's own gateway client against the local gateway.
- **Node links**: invokes are routed per node (`node-routing.ts`); events
  from another node come through `NodeEventRelay` leases
  (`watch_node_events`) or the multiplexed relay route
  (`/__orkestrator/nodes/events`, at most 8 nodes per request, 8 MiB frames,
  16 MiB queued), each with a `resync` hint on every open or gap. Relayed
  invokes pass the workspace allow-list (`admitsWorkspaceCommand`,
  `access: "workspace"` command definitions).
- **Stamped invalidations**: `native-agent-session-activity` carries an
  observation `generation`/`revision`, and `resource-changed` a contiguous
  resource revision; clients treat both as invalidations and re-read on a gap
  or reset (`native-observation-events.ts`, `resource-sync.ts`).
- **The view-sync contract**: owner generation plus contiguous revision,
  `ViewSnapshotOutcome` conditional answers, and `createBoundedHydration` on
  the client.
- **The bridge observer**: one content-free `/event/subscribe?observe=1`
  connection per Claude or Codex bridge, whose frames carry only an event
  type, a cursor and a session id. Today a frame only wakes the backend's
  activity sweep for the whole group; it never reaches a client.
- **Conditional reads**: the live view's combined read already answers
  `unchanged` against the tokens it holds, so a change signal followed by
  that read costs one small request.

#### D3. Transport: one channel per client

Push frames ride each client's existing authoritative event stream. No new
socket, route or transport.

- **Subscriptions are commands.** `gateway.connected` gains a `streamId`
  (random, per connection, bound to the credential that opened the stream).
  A client sets its whole subscription set with one idempotent command,
  `push_set_subscriptions({ streamId, setRevision, subscriptions })`, sent
  through `/__orkestrator/invoke` like any read. The backend refuses a
  `streamId` opened by a different credential. The set is replaced, not
  patched, so a retry or a reordered call is harmless (`setRevision` orders
  them; an older one is ignored).
- **Subscriptions belong to the connection.** The backend forgets them when
  the connection closes. A client re-sends its set after every
  `gateway.connected` (fresh, replayed or reconcile).
- **Frames are per connection, not in the replay ring.** A push frame goes
  only to the connections subscribed to its key, so it must not take ring
  space from the authoritative events every client needs. A frame lost to a
  disconnect is recovered by re-subscription (D5), not by replay. The event
  name is `push.changed`; it never reaches ordinary listeners, only the
  layer's client.
- **Electron**: a window that runs its own gateway client (the default)
  behaves as a browser. A window fed by the main process's stream gets the
  `streamId` from main's `gateway.connected` and subscribes through main's
  invoke path.
- **iOS and remote browsers** use the same stream (EventSource or fetch
  stream) and the same command.

**Decision: how does a client subscribe?**

- **A command naming the connection's `streamId` (recommended).**
  - Pros: no reconnect to change topics; checked by the same command auth
    as the read it replaces; reaches other nodes through the command
    node's subscription controller over the existing relay (D10).
  - Cons: a connection-scoped id to validate, and the set must be re-sent
    after each reconnect.
- **Topics in the stream URL (`?topics=`).**
  - Pros: simplest; the subscription is the connection.
  - Cons: every mount, unmount or tab switch reconnects the stream, which
    also carries every other event; URL length bounds the set.
- **A separate WebSocket for push.**
  - Pros: bidirectional.
  - Cons: a second connection, second auth path and second reconnect ladder,
    which is what the layer exists to remove.

#### D4. Envelope and topics

A frame is a batch of change signals:

```json
{
  "event": "push.changed",
  "payload": {
    "seq": 41,
    "changes": [
      {
        "topic": "native-session",
        "key": "<environmentId>/<agent>/<logicalSessionKey>",
        "generation": "<owner generation>",
        "revision": 17,
        "parts": ["transcript", "state"]
      }
    ]
  }
}
```

- `seq` is contiguous and monotonic for the whole life of a connection
  (its `streamId`): the first `push.changed` frame on a connection is 1 and
  every later one is the previous plus 1. It never resets, not after a
  `push_set_subscriptions` answer and not after a re-subscription, so a
  frame's `seq` alone places it in the connection's order whichever set it
  was sent under. A gap means the backend dropped frames for this connection
  (D6) and is answered by re-subscribing; the next frame continues the same
  numbering.
- `generation` and `revision` are the topic owner's stamp for that key, as
  in the view-sync contract: equality and ordering within one generation,
  never compared across keys or generations.
- `parts` names which reads moved, so the client reads only those (for the
  live view: `transcript`, `state`, `discovery`). Unknown parts mean "read
  everything".
- Nothing else is in a frame: ids, revisions and part names only, so a frame
  holds nothing the subscriber's read would not show (invariant 12).
- A batch holds at most 64 changes and 16 KiB encoded.

Initial topic catalogue (each later surface adds one):

| Topic | Key | Parts | Read it replaces the poll of |
| --- | --- | --- | --- |
| `native-session` | environment, agent, logical session key | `transcript`, `state`, `discovery` | `get_native_agent_live_update`, `get_native_agent_discovery_update` (C01) |
| Later (task 4) | per surface | per surface | Multi Review reviewer tab (C05), Files panel (C02), pipelines, agent mail, tickets, by measured volume |

**Decision: what does a frame carry?**

- **A change signal (topic, key, revision), after which the client reads
  the data it needs with the existing conditional reads (recommended, as in
  the original analysis).**
  - Pros: payloads keep one source of truth and one size bound; a dropped
    frame costs one read; works for every data type without a per-type wire
    format.
  - Cons: one read per change, so a fast-streaming turn still makes reads
    (but only when something moved).
- **The changed data itself (deltas or snapshots in the frame).**
  - Pros: fewest round trips.
  - Cons: a second encoding of every surface, bigger frames to bound, and a
    delta protocol per type.

#### D5. Ordering, resume and gap recovery

- **Subscribe before snapshot (invariant 7).** `push_set_subscriptions`
  registers every subscription first, then reads each key's current stamp,
  and answers `{ setRevision, seqBase, subscriptions: [{ topic, key,
  status, generation, revision }] }`. `seqBase` is the last `seq` the
  connection had been sent when the new set was registered (0 if none).
  Any change after registration is delivered as a frame with
  `seq > seqBase`, so nothing between the registration and the answer is
  lost. `status` is `ok`, `denied` or `missing` per subscription; one bad
  key never fails the set.
- **Frames and answers travel separately.** The answer comes back on the
  invoke response and frames on the event stream, so either can arrive
  first. The client checks `seq` contiguity across the whole connection as
  frames arrive, independently of answers, and acts on each frame against
  the set it currently holds: a change for a key it is not subscribed to is
  dropped, and one at or below the stamp it already read is ignored. Frames
  with `seq <= seqBase` were sent under an earlier set; because a frame is
  only an invalidation, acting on one for a key that is still subscribed
  costs at most one extra conditional read and never hides a change. While
  a `push_set_subscriptions` call is in flight the client keeps frames it
  receives and applies the answer's stamps and any frame with
  `seq > seqBase` once the answer lands. An answer whose `setRevision` is
  older than the newest one the client sent is ignored (D3), so a reordered
  answer cannot roll the set back.
- **The client compares, then reads.** For each subscription it holds the
  stamp of what it last read. If the answer's stamp differs (or the
  generation changed), it reads the named parts once through its existing
  read coordinator. A frame for a key whose revision is at or below what the
  client already read is ignored.
- **Latest wins per key.** Frames may coalesce intermediate revisions of one
  key (D6); the client does not need every revision, only to know that it is
  behind. Loss of a frame is detected by the connection's `seq`, not by
  per-key contiguity.
- **Reconnect.** The stream's own resume is unchanged: the connected frame
  echoes the client's cursor and replay runs as today (invariant 8). After
  `gateway.connected` the client re-sends its set with the stamps it holds,
  and the answer tells it what moved while it was away. A `seq` gap, a
  `push.resync` frame, a refused `streamId` or a backend restart (new
  `streamId` world) all take the same path.
- **Backend restart.** Owner generations change, so every key's stamp
  differs and each view reads once, as `native-event-stream-connected` does
  today.
- **Hidden documents and inactive views.** A view that is not mounted is
  not subscribed; it reads when it mounts, as today (invariants 1 and 2).
  A hidden document keeps its subscriptions but defers reads to the read
  coordinator's return reconcile, as today.

**Decision: how is `seq` numbered across subscription changes?**

- **One monotonic `seq` per connection, never reset; the answer's `seqBase`
  marks where the new set took effect (recommended).**
  - Pros: gap detection does not depend on which channel arrives first; a
    `seq` of 1 can only mean a new connection; a set change needs no epoch
    in every frame.
  - Cons: a frame sent under the old set can reach a client after it changed
    its set, costing at most one redundant conditional read.
- **Reset `seq` to 1 on every answer and add `setRevision` to every
  `push.changed` payload.**
  - Pros: the client can drop frames from a superseded set exactly.
  - Cons: a larger frame; the client must hold frames until the answer for
    their `setRevision` arrives before it can check contiguity, and a reset
    looks like a gap whenever a frame overtakes its answer.

#### D6. Back-pressure and bounds

- **Per connection, a coalescing map, not a queue.** Pending changes are a
  map keyed by (topic, key) holding only the latest stamp and the union of
  parts, so its size is bounded by the subscription count, not by the change
  rate.
- **Bounds.** At most 512 subscriptions per connection and 16 topics; a
  subscription key at most 1 KiB; the pending map at most 512 entries and
  256 KiB; a frame at most 64 changes and 16 KiB. Exceeding a subscription
  bound answers `denied` with reason `limit` for the excess; exceeding a
  pending bound replaces the map with one `push.resync` naming the topics
  (or `all`).
- **Throttle per key, leading edge.** The first change after a quiet period
  is sent at once (well under a frame flush, 50 ms coalescing); further
  changes to the same key are held until 500 ms after the last frame for it.
  A streaming turn therefore makes at most two reads a second per viewer,
  today's rate, while a quiet one makes none.
- **Slow sockets.** While the connection's write buffer is above the
  existing 1 MiB soft limit, frames are held in the map (it only coalesces).
  Above the 8 MiB hard limit the connection is destroyed as today, and the
  client's reconnect re-subscribes.
- **Never silent.** Every drop becomes either a `seq` gap or a `push.resync`
  frame (invariants 5, 6 and 11); the recovery poll (D8) covers a backend
  that fails to send either.

**Decision: the per-key throttle while a key keeps changing?**

- **500 ms (recommended).**
  - Pros: a streaming turn costs at most today's request rate; the first
    change after quiet still arrives at once.
  - Cons: streaming updates are no smoother than today.
- **250 ms.**
  - Pros: smoother streaming.
  - Cons: up to twice today's reads while streaming, against a baseline
    where 39–40 of 40 streaming rounds already carried a change.

#### D7. Bridge revisions: the change signal

The backend learns that a session moved without reading it (task 2):

- **Every bridge keeps a per-session state revision** (`generation:counter`,
  the generation new per bridge process) that moves on every change of
  anything its state read returns: the state body, questions, plan
  approvals, interactions, approvals, Codex's `/config` and Pi's composer.
  The transcript keeps its own content revision (Claude's transcript token,
  Codex's `messageRevision`), named separately.
- **The state route answers `unchanged`** to a matching `knownToken`, and
  the side routes are read only when the revision moved. The state and
  side-route reads of a quiet poll become one small request instead of
  four. The transcript read is not part of this revision: until task 3 it
  stays, so a poll with nothing new costs two bridge requests instead of
  five (baseline B's route list).
- **The observer stream carries the revisions.** Each `?observe=1` frame
  for a session gains `stateRevision` and `transcriptRevision` (still no
  content). Cursor, Pi and the ACP bridge gain the same observer stream
  Claude and Codex have. OpenCode 2's own `/api/event` stream (B22) is its
  change signal.
- **The backend turns bridge frames into topic changes.** The observer
  currently wakes the whole bridge group; it gains a per-session path that
  marks the `native-session` key dirty with the parts that moved. The
  backend's own changes to a session's view (queue, dispatch, title,
  discovery renewals, the existing invalidation causes in
  `NATIVE_SESSION_INVALIDATION_CAUSES`) mark it dirty too, so one revision
  per key covers both sources.
- **Only subscribed keys emit.** A key with no subscriber is not stamped or
  sent; the revision is computed when a subscription asks for it.
- **The test that keeps it honest.** Each bridge gets a harness that
  snapshots its state read before and after every mutation path its tests
  already drive and fails when the body changed but the revision did not.

#### D8. The recovery poll

- **Healthy channel:** each mounted view sends one conditional read every
  30 s (an `unchanged` answer), in place of 500 ms (running) and 1.5 s
  (idle) rounds.
- **Unhealthy channel:** the view returns to today's C01 cadence while the
  stream is disconnected, after a `push.resync` or `seq` gap until the next
  subscription answer, while a subscription is `denied` or `missing`, and
  against a backend that does not advertise the layer (`pushVersions` in
  `get_native_agent_sync_capabilities`).
- **Diagnostics.** A recovery read that finds a change no frame announced is
  counted (`push.recovery-found-change`, by topic), so a silent bug in the
  layer shows as a counter, not a frozen view.

#### D9. Migration order

1. **Bridge revisions (task 2).** Useful alone: the four state and
   side-route requests of a poll become one `unchanged` answer while the
   state did not change; the transcript read stays, so the poll goes from
   five bridge requests to two. Measured with spec B, counting state and
   transcript requests separately.
2. **The layer's core (task 3, part 1).** `streamId`,
   `push_set_subscriptions`, frames, bounds, metrics, the command node's
   node subscription controller (D10) and the client controller in
   `packages/protocol` (shared by the web and desktop clients), with
   contract fixtures. Shipped together with step 3, since
   there are no shims and no consumer-less release.
3. **The `native-session` topic (task 3, part 2).** The live view
   subscribes per mounted session, reads on frames, keeps the 30 s recovery
   poll, and the 500 ms and 1.5 s rounds and the quiet backoff ladder are
   removed. The observation broker's activity announcements stay for their
   other consumers (workflows, mail, the coordinator, the sidebar).
   Measured with specs A and B against this file's baseline.
4. **Further surfaces (task 4)**, one change each, after a measurement of
   every command's request rate. Candidates from recurring-work.md: the
   Multi Review reviewer tab (C05, 4 s), the Files panel (C02, 5 s, which
   already has a revision feed), the coordinator view (C11, already
   invalidation-led), initialization logs (C07, 1 s), pipelines, agent mail
   and tickets.
5. **The living doc (task 5).**

#### D10. Authentication and scope

- **The stream** is opened and kept as today: authenticated before any
  route, closed when its credential is revoked or expires; a client grant
  may use it.
- **A subscription is checked like the read it replaces.** The subscribe
  command is an ordinary registry command with `access: "workspace"`, so a
  grant and a relayed workspace invoke may call it, and each subscription is
  resolved by the same lookup the read uses (environment exists, session key
  belongs to it); a key the caller could not read answers `denied` or
  `missing`.
- **Frames carry nothing beyond what the read would show**: ids, stamps
  and part names.
- **Node scopes: the command node owns the leaf subscription.** The leaf
  stream a window's node events arrive on is not the window's own.
  `NodeEventRelay` (`apps/backend/src/core/nodes/node-event-relay.ts`) keeps
  one upstream stream per node for every lease that watches it, takes the
  union of their prefixes in `sync()`, and may replace that stream when a
  new prefix is added. If each window sent its whole set to the leaf with
  that shared stream's `streamId`, two windows viewing different sessions
  would replace each other's set, and their independently chosen
  `setRevision` values would make the leaf ignore one of them, leaving that
  window on the recovery poll. So a window never subscribes on a leaf
  directly:
  - The window sends its set for a node scope to its command node, as an
    ordinary `push_set_subscriptions` naming its own command-node `streamId`
    and the node id (`{ streamId, setRevision, nodeId, subscriptions }`).
    The command node checks it like any subscription.
  - A **node subscription controller** on the command node, beside the
    relay, owns the upstream subscription for each leaf stream. It
    reference-counts each (topic, key) across its downstream connections,
    sends the leaf the union with its own `setRevision` counter (one writer
    per upstream `streamId`, so revisions never collide), and drops a key
    from the union when its last downstream subscriber unsubscribes or
    disconnects.
  - The leaf's answer stamps are copied into each downstream answer that
    asked for those keys. A leaf `push.changed` frame is fanned out into the
    coalescing map (D6) of every downstream connection subscribed to each
    changed key, which then numbers it in its own `seq`. Downstream clients
    never see the leaf's `seq`; the controller checks it.
  - A leaf `seq` gap, a leaf `push.resync`, a new upstream `streamId` (the
    relay replaced or reopened the stream) or the relay's `resync` hint
    (`{ kind: "resync" }`) makes the controller re-send the union to the
    leaf and send each affected downstream connection a `push.resync` for
    that node, so each window re-reads what it holds there.
  - The same controller serves the multiplexed relay route
    (`/__orkestrator/nodes/events`) when that is how the leaf stream
    reaches the command node.

  The relay's own bounds (8 MiB frames, 16 MiB queued) still apply, the
  leaf throttles as in D6, and the controller's union is bounded by the
  leaf's subscription limit (512, D6): a downstream subscription that would
  exceed it answers `denied` with reason `limit`. A remote node adds no new
  unbounded hop.
- **Electron** keeps its bearer stream; the renderer's commands carry the
  same identity as its reads.

**Decision: who owns a leaf subscription for node scopes?**

- **A subscription controller on the command node that unions and
  reference-counts downstream sets over the shared leaf stream
  (recommended).**
  - Pros: works with the relay as built (one leaf stream per node); one
    subscriber per key at the leaf however many windows view it, so a
    second viewer adds no leaf traffic; one `setRevision` writer per
    upstream stream.
  - Cons: a fan-out component with its own bounds and tests; a leaf gap
    resyncs every window viewing that node.
- **A separate leaf stream per downstream client, each subscribing with its
  own `streamId`.**
  - Pros: no shared state; each window's set is independent.
  - Cons: the relay shares one stream per node on purpose, so this either
    abandons that or runs a second relay path; leaf connections and frames
    multiply per viewer, which is the cost the layer exists to remove.

#### D11. Metrics (content-free)

A `push` block in the gateway's `/__orkestrator/metrics` and
`get_recurring_work_diagnostics`: connections with subscriptions,
subscriptions by topic, frames and changes sent, changes coalesced, resyncs
by reason (`seq-gap`, `pending-bound`, `reconnect`), denied subscriptions by
reason, and recovery reads that found an unannounced change, all by topic.
No keys, ids or revisions are logged (invariant 12).

#### D12. Test strategy

- **Contract fixtures** in `packages/protocol`, run by the browser and
  desktop clients as the event-stream fixtures are: subscribe-before-
  snapshot, a change between registration and answer, coalescing, `seq` gap,
  `push.resync`, a reconnect that re-subscribes, a generation change, a
  denied and a missing subscription, a refused `streamId`, a revoked
  credential. Ordering across the two channels: frames that arrive before
  the subscription answer they follow, a set replaced while frames sent
  under the old set are still in flight, and an answer that arrives after a
  newer one; each must end with no false `seq` gap, no lost invalidation
  and the newest set in force.
- **Backend units on a virtual clock**: the throttle, the coalescing map's
  bounds, the subscription limits, per-connection cleanup on close, and that
  unsubscribed keys cost nothing.
- **Per-bridge revision harness** (D7) for Claude, Codex, Cursor, Pi and
  ACP.
- **Hook tests** for the live view: frame-driven reads, the 30 s recovery
  poll, falling back to C01 while unhealthy, and two views of one session
  sharing a read.
- **Live, same specs as the baseline**: `running-quiet` and
  `running-quiet-two-viewers` (A) and `conditional-reads-live` for Claude
  and Codex (B) on the old commit and the new one; the inactive and reconnect
  cases already in `agent-tab-requests-live.spec.ts` must still pass.
- **Fault injection**: drop `push.changed` frames at the page (route
  interception) and check the recovery poll converges within 30 s and is
  counted; cut the stream mid-turn and check re-subscription catches up.
- **Node scopes**: the two-profile federation fake model
  (`federation-two-profile-fake-model.ts`) with a session on the leaf viewed
  from the command node. Two clients of the command node view different
  sessions on the same leaf: both receive push; changing one client's set,
  then closing that client, leaves the other subscribed and receiving
  frames. A leaf stream replaced by the relay (a new prefix) re-sends the
  union and resyncs both clients. Backend units cover the controller's
  reference counts, its `setRevision` counter and its union bound.

#### D13. Expected effect

From the baseline: a quiet running tab goes from 2.2 requests and about
5.7 KB a second per viewer (A) to about one `unchanged` read per 30 s per
viewer plus discovery reads only when discovery moved. At the bridge (B),
task 2 alone takes a poll whose state did not change from five requests to
two (one `unchanged` state answer plus the transcript read); with task 3
the transcript is read only when a frame names it, so a quiet poll costs one
request and quiet turns make few polls at all. Streaming
stays at or below today's two reads a second per viewer. These are
expectations to measure in task 3, not results.

## Constraints and rationale

- The root `AGENTS.md` "Background Work and Transport Invariants" all apply,
  in particular: live events are incremental over authoritative snapshots;
  every missed event is detectable; replay subscribes before it calculates;
  a connected frame echoes the client's cursor; every queue has byte and
  count bounds; Codex's stdout loop never awaits a consumer.
- A structural change of this kind needs a baseline first
  ([efficiency-harness.md](../../development/efficiency-harness.md#rules-for-efficiency-changes));
  the baseline above is it.
- No backward-compatibility shims (the user's 2026-11-14 decisions).

## Open questions

Each is decided in the task that builds it, unless the user decides it in
the review:

1. **Throttle**: 500 ms or 250 ms per key while it keeps changing (D6;
   recommended 500 ms).
2. **Recovery poll**: 30 s while healthy (D8), or longer once the
   `push.recovery-found-change` counter has stayed at zero for a release.
3. **Discovery in the topic**: carried as a part of `native-session`
   (recommended, D4), or its own topic so a discovery-heavy surface can
   subscribe without the transcript.
4. **Window-level subscriptions in Electron**: whether the main process
   should subscribe on behalf of windows it feeds, or every window keep its
   own gateway client (the default today, and recommended).
5. **OpenCode**: whether its `/api/event` stream is enough as a change
   signal for every part, or OpenCode sessions keep a faster recovery poll.

## Needs verification

- The one-viewer real-Claude figures come from one run (they agree with
  1202's 2.1 requests a second) and the two-viewer figures from two. Repeat
  both on the same host when task 3 measures its result.

## Related

- [event-snapshot-recovery.md](../../architecture/event-snapshot-recovery.md)
  (the recovery contract the layer extends).
- [recurring-work.md](../../architecture/recurring-work.md) (C01 and the other
  cadences).
- [agent-testing.md](../../development/agent-testing.md#live-requests-of-a-running-agent-tab)
  (the specs that took the baseline).
- To-do 8151 (retired 2026-11-16; discovery reads during a quiet turn, found
  by the baseline):
  `git show eb32124cc:docs/todo/transcripts-and-observation/8151-discovery-reads-during-a-quiet-turn.md`.
- To-do 1202 (retired 2026-11-10) task 4:
  `git show 76a0bb93a^:docs/todo/cross-cutting/1202-efficiency-review-follow-ups.md`.
- To-do 6680 (retired) task 2:
  `git show 1ac78be57^:docs/todo/transcripts-and-observation/6680-conditional-reads-and-deltas-measured.md`.

## Replaces

Nothing; new work from 1202 (retired) task 4 and 6680 (retired) task 2.

## Assumptions and decisions

### Build push as a general event layer (user decision, 2026-11-14)

- **1202 task 4:** the user (maintainer) chose push, not long-poll or
  neither, scoped as a general push event layer: a robust, efficient,
  future-proof channel that many data types flow over, the live agent view
  first, then pipelines, mail, tickets and other live surfaces. It needs
  reconnect and resume and back-pressure, with no backward-compatibility
  shims. A recovery poll stays as a safety net only. The work starts with a
  design and a baseline per
  [efficiency-harness.md](../../development/efficiency-harness.md#rules-for-efficiency-changes)
  (task 1).
- **6680 task 2 (folded in):** build the bridge state revision as part of
  this layer: every bridge moves a revision on every state change, and it is
  the layer's change signal. Pi sends its composer and model list only when
  they changed (task 2).

### Task 1: the design waits for the user's review before any code (2026-11-15)

The ticket for phase 1 scoped it to the design and the baseline, with no
product code, and asked that phase 2 onwards wait for the user's approval.
Tasks 2 to 5 therefore depended on 7568's review item, and this file's status
was `blocked` until it was answered. It was answered on 2026-11-19 by the
user's ticket to build the layer.

### Task 1: the baseline adds a two-viewer quiet case (2026-11-15)

The named workload measured one viewer. Push removes the per-viewer
multiplier, so `agent-tab-requests-live.spec.ts` gained
`running-quiet-two-viewers` (a second browser context on the same tab during
a 110 s foreground wait) rather than relying on the loopback spec's
streaming two-viewer window alone.

### Task 1: the loopback spec runs on macOS (2026-11-15)

`conditional-reads-live.spec.ts` found the profile's toolchain directory by
reading `/proc/<pid>/cmdline`, so it ran only on Linux. On macOS it now
reads the backend's command line with `ps` and takes the value that starts
with the profile's data directory (which contains a space), so the baseline
could be taken on the Mac the maintainer uses.

### Task 3: the change signal is a backend observer per subscribed session (2026-11-19)

D7 made bridge revisions the change signal and the first migration step.
The build uses the backend's own conditional read instead: one observer per
subscribed session reads the live update with its own tokens at a single
viewer's old cadence, wakes on the session's activity announcements and
invalidations, and announces a change when a token moves. Viewers' follow-up
reads take the observer's settled answer for 750 ms
(`OBSERVED_SETTLED_SHARE_MS`), so a second viewer adds no provider read.

- **Backend observer (chosen).** Pros: works for every provider today with no
  bridge change; one provider read per session per round however many
  viewers; quiet sessions cost nothing on the wire. Cons: a quiet session is
  still read by the backend at the old cadence, so bridge requests fall by the
  number of extra viewers, not to zero; task 2 is what removes those.
- **Bridge revisions first (D7).** Pros: a quiet session costs no bridge read
  at all. Cons: five bridges' mutation sites and a revision harness each
  before any client benefits.

Task 2 stays open: when it lands, the observer can read on the bridge's
wakeup and skip quiet rounds.

### Task 3: the old cadence stays as the fallback (2026-11-19)

The 500 ms and 1.5 s rounds and the quiet ladder are not removed: they are
what a view uses while its subscription is unhealthy (no offer, a dropped
stream, a gap being recovered), as D8 requires. A healthy view uses only the
30 s recovery poll.

### Task 3: hidden documents unsubscribe (2026-11-19)

D5 kept a hidden document's subscriptions and deferred its reads. Because the
observer's reads touch provider liveness (the tab-facing routes in
[bridges/AGENTS.md](../../../bridges/AGENTS.md)), a hidden document sends an
empty set instead, so nothing keeps an unwatched session attached; returning
re-subscribes and the answer's stamps say what moved.

### Task 3: the subscribe command is answered by the gateway (2026-11-19)

`push_set_subscriptions` is a registered `system` command (so grants, the
manifest and the domain client know it), but the gateway answers it, because
only the gateway knows which credential opened the stream. The registry's
handler answers `refused` to an in-process caller.

### Task 1: review corrections to the draft (2026-11-15)

A multi-model review of the draft found four problems, corrected before the
draft goes to the user:

- **`seq` rule.** D4 reset `seq` at every subscription answer while D5's
  `seqBase` assumed it did not, and answers and frames travel on separate
  channels. `seq` is now monotonic for the whole connection, `seqBase` marks
  where a new set took effect, and D5 says how a client treats frames that
  overtake their answer. The alternative (reset plus `setRevision` in every
  frame) is recorded in D5's decision.
- **Node relay ownership.** `NodeEventRelay` shares one leaf stream per
  node, so per-window sets sent straight to the leaf would overwrite each
  other. D10 now gives the command node a subscription controller that
  unions and reference-counts downstream sets; D9 and D12 include it.
- **Savings claim.** The transcript read is not covered by the state
  revision, so task 2 takes a quiet poll from five bridge requests to two,
  not one; the transcript poll goes in task 3. Task 2, D7, D9 and D13 say so.
- **Section order.** Constraints and rationale now precedes Open questions,
  as the to-do layout requires.
