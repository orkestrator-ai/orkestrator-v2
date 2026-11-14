# A general push event layer, starting with the live agent view

From to-do 1202 (retired 2026-11-10) task 4 and to-do 6680 (retired) task 2.
A visible running agent tab still polls: about 2.1 requests a second, each an
`unchanged` answer of about 1.6 KB on the wire when nothing moved. On
2026-11-14 the user (maintainer) chose to build push, scoped as a general
event layer that many kinds of data flow over, with the bridge state revision
from 6680 as its change signal.

## Task analysis

Analysed 2026-11-14 against `main` at `066992035`. Nothing has been built.

### Tasks

1. **Design and baseline**: write the layer's design and take the before-measurement per the efficiency rules, before any code. Status: open.
2. **Bridge state revision**: every bridge moves a revision on every state change, and Pi sends its composer and model list only when they changed. Status: open (depends on 1).
3. **The live agent view over push**: the first consumer, with a recovery poll kept only as a safety net. Status: open (depends on 1 and 2).
4. **Further surfaces**: pipelines, agent mail, tickets and the other live surfaces move onto the layer, one at a time. Status: open (depends on 3).

### 1. Design and baseline

**Problem.** Each live surface has its own polling or stream, so every new
one adds requests, and none shares reconnect, resume or back-pressure.

**Context.** The numbers the decision was made on (1202 task 4, 2026-11-04,
and 6680): a visible running Claude tab sends about 2.1 requests a second
(down from 6.2 after WEB-1 and GW-1), one combined read
(`get_native_agent_live_update`) per 500 ms round; an `unchanged` answer is
about 1.6 KB on the wire; the bridge spends under 0.25 ms on a state read,
about 1 ms on a transcript read and 3.7–4.2 ms near the 512 KiB window bound.
Today's cadence is C01 in
[recurring-work.md](../../architecture/recurring-work.md). Existing streams:
the backend event fanout (`apps/backend/src/core/backend-event-fanout.ts`),
the renderer's event client (`apps/web/src/lib/native/events.ts`), the
shared terminal stream for bearer clients (`web-gateway.ts`, GW-3), and the
bridges' content-free `?observe=1` wakeup stream. The baseline workload is
`running-quiet` in `e2e/agent-testing/agent-tab-requests-live.spec.ts`
([agent-testing.md](../../development/agent-testing.md#live-requests-of-a-running-agent-tab)).

**Investigation.** Not started. The design must answer, in a doc under
`docs/architecture/` once built (draft it in this file first):

- one channel per client connection carrying many topics (a subscription per
  topic and key), over the transports the window already has (Electron IPC,
  the gateway's SSE or fetch stream for web and iOS clients, node links);
- framing with a revision per topic, so a gap is always detectable, and a
  reconciliation frame that tells the client to read the authoritative
  snapshot (root `AGENTS.md` transport invariants 3, 4, 7 and 8);
- reconnect and resume from the client's cursor, never jumping it to the
  latest revision before replay completes;
- back-pressure with byte and count bounds per connection and per topic;
  when a bound is hit the server drops to "changed, re-read" for that topic
  rather than queueing (invariants 5, 6 and 11);
- authentication and scope: a subscription is checked like the read it
  replaces, per node scope;
- content-free metrics (invariant 12);
- no backward-compatibility shims: every client and backend updates together
  (the user's 2026-11-14 decisions), so the old polling path is removed
  where a surface moves, except the recovery poll.

**Decisions.**

- **What does a push frame carry?**
  - **A change signal (topic, key, revision), after which the client reads
    the data it needs with the existing conditional reads (recommended).**
    - Pros: payloads keep one source of truth and one size bound; a dropped
      frame costs one read; works for every data type without a per-type
      wire format.
    - Cons: one read per change, so a fast-streaming turn still makes reads
      (but only when something moved).
  - **The changed data itself (deltas or snapshots in the frame).**
    - Pros: fewest round trips.
    - Cons: a second encoding of every surface, bigger frames to bound, and
      a delta protocol per type.
- **Where does the layer start?**
  - **In the backend, fed by bridge revisions and storage events, fanned out
    over each client's existing connection (recommended).**
    - Pros: one subscription point; bridges stay behind the backend as today.
    - Cons: the backend must watch bridge revisions cheaply (task 2).
  - **Clients subscribe to bridges directly.**
    - Pros: one hop fewer.
    - Cons: bypasses the backend's auth, scopes and node routing.

### 2. Bridge state revision

**Problem.** The backend can only learn that a bridge's session state changed
by reading it; Claude's state body repeated on 35 of 39 streaming polls with
one viewer (76 of 80 with two), and Pi's `/status` sends its whole composer
on every poll (130 KB with 300 models on the fake bridge).

**Context.** 6680 (retired) task 2 and task 3's composer analysis
(`git show 1ac78be57^:docs/todo/transcripts-and-observation/6680-conditional-reads-and-deltas-measured.md`).
Building it adds an invariant in every bridge (Claude, Codex, Cursor, Pi and
the ACP bridge): every state change moves the revision. Codex's `/status`
body changed on almost every streaming poll, so a revision spares Codex
little on its own; its value is as the push layer's change signal. Bridge
rules: [`bridges/AGENTS.md`](../../../bridges/AGENTS.md).

**Investigation.** Not started.

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

### 3. The live agent view over push

**Problem.** The live agent view is the busiest poller and the first consumer
the decision names.

**Context.** `useNativeAgentSession.ts`, `native-session-read-policy.ts`
(C01). The recovery poll stays as a safety net only.

**Investigation.** Depends on 1 and 2. Measure against task 1's baseline with
the same spec and workload, and test the inactive-environment path (start a
turn, switch away, return, reload).

**Decisions.**

- **How slow is the safety-net poll?**
  - **Long (tens of seconds) while the channel is healthy, back to today's
    cadence while it is down or desynced (recommended).**
    - Pros: a broken channel degrades to today's behaviour, never worse.
    - Cons: two modes to test.
  - **No poll while the channel is healthy.**
    - Pros: fewest requests.
    - Cons: a silent bug in the layer would freeze a view; the decision
      keeps a recovery poll.

### 4. Further surfaces

**Problem.** Pipelines, agent mail, tickets and other live surfaces poll or
stream separately.

**Context.** Their cadences are in
[recurring-work.md](../../architecture/recurring-work.md).

**Investigation.** Depends on 3. Each surface is its own change with its own
before and after numbers.

**Decisions.**

- **Order?**
  - **By measured request volume, highest first (recommended).**
    - Pros: the biggest saving lands first.
    - Cons: needs the numbers first.
  - **By how simple the surface is.**
    - Pros: quick wins.
    - Cons: may move surfaces that cost little.

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

## Constraints and rationale

- The root `AGENTS.md` "Background Work and Transport Invariants" all apply,
  in particular: live events are incremental over authoritative snapshots;
  every missed event is detectable; replay subscribes before it calculates;
  a connected frame echoes the client's cursor; every queue has byte and
  count bounds; Codex's stdout loop never awaits a consumer.
- A structural change of this kind needs a baseline first
  ([efficiency-harness.md](../../development/efficiency-harness.md#rules-for-efficiency-changes)).

## Related

- [recurring-work.md](../../architecture/recurring-work.md) (C01 and the other
  cadences).
- To-do 1202 (retired 2026-11-10) task 4:
  `git show 76a0bb93a^:docs/todo/cross-cutting/1202-efficiency-review-follow-ups.md`.
- To-do 6680 (retired) task 2:
  `git show 1ac78be57^:docs/todo/transcripts-and-observation/6680-conditional-reads-and-deltas-measured.md`.

## Replaces

Nothing; new work from 1202 (retired) task 4 and 6680 (retired) task 2.
