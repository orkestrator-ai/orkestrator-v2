# Discovery reads during a quiet turn: whole bodies, more often than the backstop

Found on 2026-11-15 while taking 8102's polling baseline.

## Task analysis

Analysed 2026-11-15 against `main` at `a8b89f154`.

### Tasks

1. **Attribute the discovery reads and their size**: find which trigger sent each discovery read in a quiet running Claude turn, and whether each answer was a whole body. Status: open.
2. **Stop re-sending an unchanged discovery view**: depending on 1, make a renewal that changes nothing answer `unchanged`, and keep reads to what the schedule intends. Status: open (depends on 1).

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

**Investigation.** Not started. A hypothesis to test first: the backstop
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

**Investigation.** Depends on 1.

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

## Related

- [8102](8102-push-event-layer.md) (the push event layer and its baseline).
- [recurring-work.md](../../architecture/recurring-work.md) (C01).
