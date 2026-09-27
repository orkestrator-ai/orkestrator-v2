# 17 — Coordinate visible reads and batch backend activity observations

Status: Not started. Prerequisites: 08, 09; coordinate reviewer integration with
15. Finding: E11.

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
