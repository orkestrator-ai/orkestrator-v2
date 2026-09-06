# TODO: client data-saving mode

Status: deferred proposal; recommendation 5 from the remote-bandwidth review.

Related work: [remote-client efficiency plan](../efficiency-plan.md), covering
conditional reads, incremental projections, history pages, and scoped
invalidations. Complete and measure those changes before choosing new defaults.

## Problem

The native-agent hook polls every 500 ms during active phases and 1,500 ms while
idle. It respects active-tab state, but its interval has no explicit browser
document-visibility check. The files panel polls every five seconds while open;
conditional snapshots already keep unchanged file response bodies small.

On mobile or constrained connections, request overhead, frequent updates, and
hidden-document reads can still consume data and battery after payload sizes
are reduced.

## Proposed work

- Add a device/client-local data-saving preference. It must not change a shared
  backend's cadence for other connected clients. Persist it through the existing
  client-settings mechanism and expose a clear user control.
- Centralize read scheduling instead of adding independent timers per feature.
  Combine activity, document visibility, connection state, and explicit user
  preference. Treat network hints as optional; do not assume every browser has
  them or that they accurately identify metered access.
- Trial a one-second active refresh and progressive idle backoff to 5–15 seconds.
  These are experiment values, not established defaults. Reset backoff on user
  action, a relevant invalidation, reconnect, or return to visibility.
- Suspend presentation-only polling in hidden documents. Keep backend work and
  authoritative state tracking running. Reconcile immediately when visible.
- Keep approvals, completion, errors, queue/dispatch controls, and safety state
  responsive through reliable invalidations. Retain a recovery poll until every
  provider's backend monitoring has demonstrated complete event coverage.
- Use small status/interaction reads where necessary; do not fetch history just
  to keep an activity indicator or prompt current.
- Reduce or detach hidden terminal presentation subscriptions only when exact
  snapshot recovery is available. Unsubscribing a view must never terminate the
  terminal or agent process.
- Bound pending refreshes and merge duplicate invalidations. Avoid a synchronized
  burst of all subscriptions when a device resumes; prioritize visible session
  state and pending interactions, then reconcile secondary views.

## Likely implementation locations

- `apps/web/src/hooks/useNativeAgentSession.ts`
- `apps/web/src/hooks/useFilesPanel.ts`
- `apps/web/src/lib/native/web-gateway.ts`
- `apps/web/src/components/terminal/TerminalContainer.view.tsx`
- The shared refresh coordinator introduced by the efficiency plan
- Existing client preference store/settings UI, to be identified before editing

## Acceptance and measurement

- [ ] Data-saving preference affects only the requesting client.
- [ ] Hidden views stop scheduled presentation reads without cancelling work.
- [ ] Returning/reconnecting restores exact state, including pending approvals,
      errors, queued prompts, and parked dispatch controls.
- [ ] Offline periods and missed invalidations recover through authoritative
      reads, with bounded retries and no prompt resubmission.
- [ ] Idle/active transferred bytes and request counts improve measurably against
      the optimized baseline with data-saving mode disabled.
- [ ] Completion/approval visibility latency remains within an explicitly chosen
      acceptance budget; record p50/p95 and do not hide the latency tradeoff.
- [ ] Real isolated browser QA covers backgrounding, screen lock/resume where
      available, tab switches, two clients with different preferences, reload,
      and throttled/disconnected connections.

Do not change stream compression as part of this item; it has a separate
[evaluation task](remote-stream-compression.md).
