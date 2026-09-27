# 17 — Coordinate visible reads and batch backend activity observations

Status: Complete — frontend half shipped in 0ba8628e; batched no-touch activity added here. Prerequisites: 08, 09; coordinate reviewer integration with 15. Finding: E11.

## Outcome

Hidden documents stop routine presentation reads, visible clients reconcile
promptly, and a backend activity sweep uses bounded batches rather than one
sequential HTTP request per session. Background work and interaction supervision
continue regardless of frontend visibility.

## Owners

- [Native hook](../../../../apps/web/src/hooks/useNativeAgentSession.ts),
  [files panel](../../../../apps/web/src/hooks/useFilesPanel.ts), reviewer tab.
- [Backend reconciliation](../../../../apps/backend/src/core/native-agent-service-reconciliation.ts).
- [Provider contract](../../../../apps/backend/src/core/agent-provider-contract.ts),
  [HTTP provider](../../../../apps/backend/src/core/http-bridge-provider.ts),
  [activity transport](../../../../apps/backend/src/core/http-bridge-transport.ts).
- Bridge activity routes; proposed small frontend read scheduler module.

## Frontend scheduling

1. Build a shared scheduler keyed by backend connection identity, environment,
   provider session/logical session, domain, and window/representation. Do not
   join reads across two backend connections that happen to use the same IDs.
2. Inputs are document visibility, active view subscriptions, connection state,
   phase, pending manual reads, and scoped invalidations. Keep the current
   500/1,500 ms visible cadence initially; a separate measured change may back
   off idle polling. Do not change server-global cadence from one client's
   preference.
3. Hidden documents stop scheduled transcript/discovery/files/reviewer reads.
   Record a bounded dirty marker for invalidations instead of issuing one hidden
   read per event. Backend state monitoring continues. Any deliberate hidden
   client notification feature needs its own small state-domain policy.
4. On visibility/reconnect, prioritize action-critical state and visible tail,
   then history/detail/discovery work. Coalesce bursts, add bounded scheduling
   jitter for secondary views, and permit only one dirty trailing refresh per
   identity/domain. Manual user refresh may bypass a cadence delay but not
   concurrency or byte admission.
5. Cancellation unsubscribes the consumer and does not terminate shared backend
   work. Ignore old-generation responses and clean up timer/listener ownership.
   Keep recovery polling until provider event coverage is demonstrated; do not
   turn this into an event-only design.

## Backend batch activity

1. Add a capability-gated no-touch batch route taking a bounded set of session
   IDs. It must not hydrate transcripts, attach agents, refresh `lastAccessed`,
   render messages, or call catalogue/status endpoints that do those things.
2. Preserve the complete observation: activity, readiness, async-question IDs,
   and any existing authoritative fields. The current `activityBatch` returns
   only states; add a richer optional observation-batch contract or extend it
   compatibly rather than losing attention/readiness metadata during batching.
3. Validate request count/bytes and bound the response. Split oversized groups
   into bounded chunks; handle an oversized observation explicitly. Never omit
   a session or attention item and let the caller infer idle from absence.
4. Return unknown sessions in band as missing only when the bridge can prove
   nonexistence. Existence-probe errors remain unknown/unavailable, preserving
   Claude's conservative behavior. Unsupported-route 404 must not be confused
   with an individual deleted session.
5. Retain worker concurrency/fairness and provider retry backoff. Batch failure
   marks its covered observations uncertain; it does not evict unrelated
   session mappings or cause a retry storm. Older bridges use the bounded
   individual no-touch fallback.

## Tests and acceptance

Use deterministic clocks and isolated visibility changes. Verify zero routine
presentation requests while hidden, one coalesced recovery on return, pending
approval correctness, and two clients with different visibility. Test manual
refresh during an in-flight invalidation and backend connection replacement.

For batches, cover 1/10/100 sessions split across bounds, partial failures,
missing IDs, metadata parity, stalled session fairness, and bridge restart.
Instrument that no liveness/hydration call occurs. Measure sweep completion time
and request reduction without increasing unsafe stale-state intervals.

Update the existing [data-saving proposal](../../../todo/remote-client-data-saving-mode.md)
to distinguish shipped scheduling from optional preference/backoff work. No new
settings UI is required just to stop hidden-document presentation polling.

## Execution record

```text
Status: Implemented, validation pending (deterministic tests pass; sweep
  latency on a named machine/profile not yet measured).
Implementation commit / PR: frontend half — 0ba8628e (#852); backend half —
  branch implement-efficiency-improvements-7f0993836777-r1.
Protocol or storage decisions:
  - Frontend (shipped in 0ba8628e, not redone here):
    apps/web/src/lib/read-coordinator.ts owns presentation-read scheduling
    (one timer per key, joined in-flight reads, one dirty trailing read,
    automatic reads paused while document.visibilityState is hidden or the
    transport is disconnected, coalesced critical-first resume).
    apps/web/src/hooks/useCoordinatedRead.ts is the hook; consumers include
    useNativeAgentSession.ts (500/1,500 ms cadence unchanged), useFilesPanel.ts
    and components/review/MultiReviewReviewerTab.tsx.
  - Wire contract: packages/protocol/src/session-activity-batch.ts
    (`@orkestrator/protocol/session-activity-batch`). POST /sessions/activity,
    request {version:1, sessionIds} (<=64 unique ids, <=1,024 UTF-8 bytes
    each, <=96 KiB body, checked against Content-Length and while streaming);
    response {version:1, observations: Record<id, entry>} with every requested
    id present and no other. An entry is the complete single-route answer
    (activity, readyForInput, asyncQuestionItemIds, Cursor's closing), or
    {activity:"unavailable"} (read threw / malformed: uncertainty), or
    {activity:"deferred"} (did not fit the 512 KiB response budget; largest
    entries are deferred first and read through the single route; no
    attention item is truncated). The path is outside /session/:id/... in
    every router. Unknown observation fields are dropped (additive
    evolution); everything else is validated strictly on both sides.
  - Bridges: each single /session/:id/activity route and the batch route call
    one shared per-bridge reader: claude routes/session-activity.ts
    (getSessionActivity + peekSession; a failed existence probe stays idle),
    codex session-activity-batch-route.ts (runtime.getActivitySnapshot), acp
    acp-activity.ts, cursor/pi session-activity.ts (publicActivity). Batch
    routes sit behind the same auth middleware; reads fan out at most 4 at a
    time per request.
  - Backend: optional contract method observeActivityBatch (additive, in
    agent-provider-contract.ts), implemented by HttpBridgeProvider through
    http-bridge-activity-batch.ts. Capability is per provider instance, i.e.
    per bridge connection identity (a restarted bridge gets a new provider);
    404/405 is the only "unsupported" signal and is negatively cached for
    5 min. A timeout, 5xx, auth failure or malformed answer rejects without
    caching.
  - Reconciliation (native-agent-activity-reads.ts, called from
    reconcileAgentActivityOnce): chunks of <=64 unique batchable ids;
    unsupported or rejected chunks, deferred ids and over-long ids fall back
    to single reads for this sweep only; batch and single reads share one
    bounded concurrency of 4 per group (the 8 group workers are unchanged).
    Answers are applied one at a time in completion order (effects are
    per-session, so order is not semantic). `missing` still unmaps only that
    session. An `unavailable` id, or any failed read, leaves that session
    unapplied, stops new reads in the group and rethrows once in-flight reads
    settle: the existing group failure path (aggregate withheld, backoff,
    provider eviction). Nothing is unmapped from absence. OpenCode's
    group-wide activityBatch path is unchanged.
Tests and isolated profiles:
  - protocol: session-activity-batch.test.ts (bounds, completeness,
    __proto__ ids, deferral, fan-out bound, bounded body reader).
  - bridges: claude routes/session-activity.test.ts (real session manager via
    the shared harness: parity with the single route, missing only from the
    existence probe, failed probe => idle, no touch/materialize/hydrate) and
    index-auth.test.ts (token); codex session-activity-batch-route.test.ts
    (real router + auth; no touchSession/ensureAttached/registry.touch/
    getStatus/getMessages calls; unavailable isolation); acp
    acp-activity.test.ts (write-recording session proxy); cursor and pi
    session-activity.test.ts (lastAccessed unchanged, no attach, no Pi
    composer hydration, parity including Cursor `closing`).
  - backend: http-bridge-activity-batch.test.ts (request shape, metadata
    parity with observeActivity, 404/405 negative cache and expiry, a new
    connection re-detects, timeout/5xx/malformed not cached);
    native-agent-activity-reads.test.ts (1/10/64/65/100 chunking, partial
    failure, missing, deferred, a rejected chunk falls back alone, shared and
    over-long ids, stalled-session fairness, concurrency bound, stop after
    failure, OpenCode path); native-agent-service-activity-batch.test.ts
    (service + real HttpBridgeProvider + fake bridge server: 1/10/100
    sessions, missing vs unavailable, old bridge not re-probed every sweep,
    503 bypassed for one sweep, bridge restart re-detects, only no-touch
    routes hit). The existing no-touch sweep test also accepts the batch
    route now.
Before/after measurements: deterministic request counts only. A sweep over
  1/10/100 sessions of one HTTP bridge group issues 1/1/2 requests instead of
  1/10/100 (an older bridge: one 404 per connection per 5 min, then the
  previous per-session reads at concurrency 4 instead of 1). Sweep completion
  time was not measured on a named machine/profile.
Compatibility/migration result: additive. New backend + old bridge: 404 =>
  cached per-session fallback. Old backend + new bridge: route unused. No
  storage change.
Remaining limitations:
  - multi-review-service.ts still calls observeActivity per session (outside
    this package's file ownership); it can adopt readActivityGroup later.
  - The ACP bridge's single route never reports `waiting`; the batch route
    mirrors it exactly rather than changing semantics.
  - A per-id `unavailable` fails the whole group, as a single-route 500 did;
    the bridge readers practically never throw (Claude's probe already maps
    errors to idle).
  - Sweep latency (p50/p95) for 1/10/100 sessions against real bridges is
    left for step 19's consolidated evidence.
```
