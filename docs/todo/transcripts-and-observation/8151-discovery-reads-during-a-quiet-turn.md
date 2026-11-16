# Discovery reads during a quiet turn: whole bodies, more often than the backstop

Found on 2026-11-15 while taking 8102's polling baseline.

## Task analysis

Analysed 2026-11-15 against `main` at `a8b89f154`. Worked 2026-11-16 against
`main` at `c1fcc573b`: both tasks done (see
[Assumptions and decisions](#assumptions-and-decisions)).

### Tasks

1. **Attribute the discovery reads and their size**: find which trigger sent each discovery read in a quiet running Claude turn, and whether each answer was a whole body. Status: done.
2. **Stop re-sending an unchanged discovery view**: depending on 1, make a renewal that changes nothing answer `unchanged`, and keep reads to what the schedule intends. Status: done.

### 1. Attribute the discovery reads and their size

**Problem.** In 8102's `running-quiet` baseline (one visible Claude tab, a
real Haiku turn in a 40 s foreground wait), every
`get_native_agent_discovery_update` answer was about 32 KB, against about
1.2–1.5 KB for each live update. Their number per viewer in 40 s was 4 (one
viewer), 3 and 3 (two viewers, first run) and 1 and 1 (two viewers, second
run). With 4, discovery carried 129,636 B, as many bytes as all 84 live
updates (126,739 B). The loopback idle windows of
`conditional-reads-live.spec.ts` agree: 2 discovery reads in 30 s, about
30 KB each for Claude and 8 KB for Codex.

**Context.** The renderer's schedule is `NativeDiscoveryReadSchedule`
(`apps/web/src/lib/native-session-read-policy.ts`): a read on mount,
identity change, resync, reconnect, an invalidation naming discovery or a
phase change; a follow-up in 2 s while a section is `loading` or `stale`, in
5 s while one is `unavailable`; otherwise the 30 s backstop
(`DISCOVERY_BACKSTOP_MS`), reusing the view's token. The backend
(`getDiscoveryUpdate` in
`apps/backend/src/core/native-agent-transcript-projection.ts`) caches each
section for 30 s when ready and 5 s after a failure; a read that finds an
expired ready section reports it `stale` and schedules a renewal. The
figures and how they were taken are in
[8102](8102-push-event-layer.md#the-polling-baseline-2026-11-15).

**Investigation.** Done on 2026-11-16; findings in
[Assumptions and decisions](#assumptions-and-decisions). A hypothesis to test first: the backstop
(30 s) and the ready TTL (30 s) are equal, so a backstop read finds the cache
just expired and answers a changed view (`stale`), whose 2 s follow-up then
answers another changed view (`ready` again), two whole bodies per 30 s
where nothing changed. Steps: record each discovery answer's status
(`unchanged` or snapshot), byte size and the schedule trigger that sent it
in the `running-quiet` case of `agent-tab-requests-live.spec.ts` (content
free: status, size, trigger name and section availabilities only); then
count the `discovery-renewal` invalidation cause in the gateway metrics'
`sessionInvalidations` over the same window.

**Decisions.**

- **How to attribute?**
  - **Extend the live spec to record status, size and availabilities per
    discovery answer, and read the invalidation-cause counters
    (recommended).**
    - Pros: real provider, real sections; reuses the spec that found it.
    - Cons: a billed Haiku turn per run.
  - **Reproduce on the loopback model only.**
    - Pros: free.
    - Cons: the fake CLI's discovery sections may not match a real
      session's (MCP servers, commands).

### 2. Stop re-sending an unchanged discovery view

**Problem.** A whole discovery body each time the cache renews costs up to
half of a quiet tab's bytes, and 8102's push layer would carry the same
renewals as discovery changes.

**Context.** The progressive view already has per-section revisions, and
[event-snapshot-recovery.md](../../architecture/event-snapshot-recovery.md#native-observation-invalidations)
says a discovery renewal must announce a change only when what a view shows
changed. 8102's design carries discovery as a part of the `native-session`
topic (D4).

**Investigation.** Done on 2026-11-16 (the recommended option, plus the two
further causes task 1 found).

**Decisions.**

- **If the hypothesis holds, what changes?**
  - **Keep serving the retained value as `ready` while a renewal of an
    expired section is in flight, so the view (and its token) changes only
    when the renewed value differs (recommended).**
    - Pros: an unchanged renewal answers `unchanged`; no extra follow-up
      read.
    - Cons: a view no longer shows that a value is being refreshed.
  - **Offset the backstop from the TTL (for example a 45 s backstop).**
    - Pros: one constant.
    - Cons: still a whole body whenever a read lands on an expired section.

## Assumptions and decisions

### Task 1: what sent each read, and what it carried

The hypothesis held, and task 1 found two further causes. A backend test
(`apps/backend/src/core/native-agent-service-quiet-discovery.test.ts`)
reads discovery on the renderer's own schedule (`NativeDiscoveryReadSchedule`:
mount, invalidation, 2 s follow-up while `loading`/`stale`, 5 s while
`unavailable`, otherwise the 30 s backstop with the view's token) against a
quiet Claude session with four sections, and records each answer's status,
size, trigger and section availabilities. Before the fix every 30 s cycle
was three whole views, none of which changed anything:

1. **backstop**: every section had just expired (ready TTL 30 s = backstop
   30 s); the read scheduled renewals and served the expired sections as
   `stale`, so the view's token changed (snapshot) and the renderer set a
   2 s follow-up;
2. **follow-up**: models and commands had renewed (`ready` again), and the
   commands section's `catalogue.fetchedAt` had moved, so another changed
   view; MCP and runtime were still `stale`, because a provider runs at most
   two discovery jobs at a time and the read that would start them had not
   come yet;
3. **second follow-up**: the read started the two refused sections, which
   then renewed `ready`: a third changed view.

Over two quiet minutes that was 9 snapshots (87,354 B on the fake session)
and no `unchanged` answer. No announcement was sent: none of these were
value changes, so the gateway's `discovery-renewal` counter stays at 0 while
the bytes flow. The attribution was taken on the loopback model only (the
to-do's second option), so no Haiku turn was billed; the
real-provider check went to the manual-test checklist (below).

### Task 2: what changed

Three changes in `native-agent-transcript-projection.ts`, one per cause:

- **An expired section is served as stored (`ready`) while it renews** (the
  recommended option). The view and its token move only when the renewed
  value does, and that change is announced (`discovery-renewal`), so the
  view reads it at once. `stale` now means a renewal failed and the value
  shown is the one before it. Rejected: a 45 s backstop. It removes the
  collision for one cadence, but any read that lands on an expired section
  (a phase change, a second viewer, a reconnect) would still send a whole
  body, and causes 2 and 3 would remain.
- **The discovery view leaves out the catalogue's `fetchedAt`.** It moves on
  every renewal, and no renderer reads it (`git grep fetchedAt apps/web`
  finds only unrelated settings code). The catalogue's `revision` already
  moves when its rows or state change. The field stays in the protocol and
  the catalogue cache.
- **A section the job limit refuses is started when a job finishes**
  (`deferredDiscoveryRenewals`), bounded to 256 entries and dropped if the
  session's projection epoch moved or the section was renewed some other
  way. Without this, the first change would have left MCP and runtime
  waiting for the next read, now 30 s away, and as models and commands win
  the two slots on every read, never renewed. Rejected: raising the
  per-provider limit to four. It is simpler, but it doubles the concurrent
  requests a bridge takes from one view, which the limit exists to stop.

Kept: the 2 s discovery deadline still marks a retained value `stale` with
"Discovery timed out". It is the only sign of a renewal that hangs (provider
reads have no overall timeout), so a renewal slower than 2 s still costs one
changed view when it misses and one when it lands. The renderer schedule is
unchanged; only its comment on `stale` was corrected.

Two existing tests described the old behaviour and were updated:
`native-agent-progressive-metrics.test.ts` (an idle view coming back now gets
`unchanged`, with all three expired sections renewed two jobs at a time),
and `native-agent-service-progressive.test.ts` (the renewal test waits for
the renewal to commit, since the read no longer has to poll through `stale`).

### Measurement

**Fake session, backend test** (two quiet minutes, four sections, renderer
schedule):

| | Snapshots | Snapshot bytes | `unchanged` answers |
| --- | --- | --- | --- |
| Before | 9 | 87,354 B | 0 |
| After | 0 | 0 | 4 (1,340 B) |

**Loopback model, real stack**: `conditional-reads-live.spec.ts` (E10,
`baseline` scenario with `E10_ROUNDS=26`, `E10_WINDOW_MS=40000`,
`E10_IDLE_WINDOW_MS=120000`) on a disposable profile started with
`ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile e10-8151
--fixture --headless --no-agent-credentials --no-host-seed --agent-platforms
claude`, once on `c1fcc573b` and once with the fix, on 2026-11-16. The spec
now records each discovery answer's status and bytes (content free). The
default 20 s / 20 s / 30 s windows caught no discovery read at all, hence
the longer windows.

| Window | Before | After |
| --- | --- | --- |
| One viewer, 40 s, turn streaming | 3 snapshots, 71,091 B | 1 snapshot + 1 `unchanged`, 24,607 B |
| Two viewers, 40 s (first / second) | 3 + 1 snapshots, 72,507 + 24,169 B | 2 + 1 `unchanged`, 954 + 477 B |
| Idle, 120 s | 4 snapshots, 96,676 B | 5 `unchanged`, 2,385 B |

Each whole Claude discovery view was about 24 KB on this profile (32 KB in
8102's real-Haiku run). After the fix a backstop answer is about 477 B. The
one remaining snapshot in the streaming window is a view that really
changed: `getDiscoveryUpdate` answers a snapshot only when the view's token
differs. Which section changed was not recorded (the spec records status
and size, not section revisions).

### Manual checking

The 8102 `running-quiet` re-measure on a real Haiku turn (real MCP servers and
commands) is billed, so it went to the manual-test checklist as
"8151 (retired) task 2".

## Related

- [8102](8102-push-event-layer.md) (the push event layer and its baseline).
- [recurring-work.md](../../architecture/recurring-work.md) (C01).
