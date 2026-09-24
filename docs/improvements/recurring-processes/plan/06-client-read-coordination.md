# 06 — Coordinate client reads and document visibility

Status: Not started. Dependencies: 01; relevant step 11 recovery contract before
slower polling. Finding: F05. Related proposal: client data-saving mode.

## Outcome

Equivalent mounted views share one refresh operation, hidden documents stop
optional presentation reads, and returning clients reconcile promptly. Backend
work and monitoring continue independently of every client subscription.

## Sources and proposed ownership

Introduce a focused module under `apps/web/src/lib/` following current transport
and store patterns. Integrate `resource-sync.ts`, `useNativeAgentSession.ts`,
`useFilesPanel.ts`, and later the step 09 consumers. Reuse existing connection
generation/reset signals, conditional tokens and projection caches.

Do not move prompt submission, approval resolution, workflow progression, or
durable queue draining into this coordinator. Its operations are read-only.

## Implementation tasks

1. Define read keys including connection identity/generation, resource kind,
   environment/session identity, options and requested view. Transcript windows
   with different limits/cursors cannot share responses unless a safe superset
   relation is explicit. Reset all pending/cache identities on server switch.
2. Represent subscriber demand: active/visible, requested freshness, explicit
   refresh, and whether the read is essential for interactive status. Aggregate
   demand for the same key without creating one timer per component. Keep a
   bounded map and evict entries after subscribers leave.
3. Join in-flight equivalent reads. Retain one dirty flag for an invalidation
   arriving after a read started. An explicit refresh must obtain a post-click
   observation; joining an older read alone does not satisfy it. Preserve the
   native hook's operation epoch/sequence fences when responses are applied.
4. Initially preserve foreground 500/1,500 ms native cadence and five-second
   file cadence. Change ownership/deduplication first so failures can be
   attributed. Keep progressive transcript/state/discovery reads separate and
   preserve unavailable/cached/current/empty distinctions.
5. Pause periodic presentation reads when the document is hidden or known
   disconnected. On visibility/focus/reconnect, coalesce signals and reconcile
   once. Browser online/offline state is a hint, not proof of backend readiness.
   Do not pause backend activity tracking or expire durable jobs with UI demand.
6. Bound resume work and prioritize session state/pending interactions before
   transcript history, file tree, metrics and auxiliary panels. Spread low-priority
   refreshes over a short bounded window to avoid every tab waking simultaneously.
   Maintain a documented maximum delay for visible critical reads.
7. Own errors and retries. Use capped jittered backoff for failed reads, reset
   after success/reconnect/explicit action where appropriate, and retain stale
   data with truthful freshness. Do not repeatedly retry permanent unsupported
   APIs; use capability fallback. Do not cache an auth failure as empty data.
8. After step 07 event coverage and step 11 recovery tests pass, trial quiet native
   backoff at 3/5/10/15 seconds. Running/blocked/recovering views keep their current
   latency budget until evidence supports a change. Record actual command and
   provider request counts per refresh before claiming savings.
9. If a data-saving preference is adopted, store it in the existing client-local
   preference layer. It changes this client's demand only. A second client with
   normal settings must retain its own freshness. Network hints may suggest a
   policy but must not silently change shared backend cadence.
10. Define disposal precisely. Subscriber unmount removes demand and invalidates
    callback application, but shared reads can continue for other subscribers.
    Cancel transport reads only where their abort does not stop backend work;
    late results must not rearm timers or overwrite newer identity state.

## Tests

Use a fake clock/document/transport and deferred read promises. Cover two
subscribers, option mismatches, delayed visibility change, rapid hide/show,
focus plus reconnect, invalidation during a read, explicit refresh during a read,
network failure, permanent unsupported API, server switch, target change,
unmount/remount and cleanup after cancellation. Assert request count, applied
revision and stale-state behavior.

Real browser coverage must include active tab in a hidden document, two windows
with different settings, environment switching during a turn, parked approvals,
completion while hidden, queued prompts, reload and missed final invalidation.
Keep old-backend coverage using conservative polling.

## Acceptance and rollback

Hidden optional views generate no scheduled read traffic; visible return obtains
authoritative state within its agreed latency. Equivalent subscribers join one
read, and no response crosses connection/session generations. Foreground behavior
matches baseline in the first migration. Roll back cadence/backoff separately
from coordinator ownership, avoiding simultaneous old and new timers.
