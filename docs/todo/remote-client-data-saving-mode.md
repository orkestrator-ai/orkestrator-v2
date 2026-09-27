# TODO: client data-saving mode

Status: Deferred — proposal; recommendation 5 from the remote-bandwidth review.
The scheduling half has shipped (below); what remains is an optional,
client-local preference and idle backoff.

Related work already in tree: conditional reads, incremental projections,
history pages, and scoped invalidations. Measure those before choosing new
defaults.

## Already shipped

- **Visibility-aware read scheduling** (efficiency plan step 17, frontend half,
  commit `0ba8628e`). [`read-coordinator.ts`](../../apps/web/src/lib/read-coordinator.ts)
  owns presentation-read scheduling: one timer per read key, joining of
  equivalent in-flight reads, and a single dirty flag that yields exactly one
  trailing read. Automatic reads pause while `document.visibilityState` is
  `hidden` or a transport is disconnected; visibility/focus/reconnect signals
  are coalesced and reconciled once, critical keys first. Consumers use it via
  [`useCoordinatedRead`](../../apps/web/src/hooks/useCoordinatedRead.ts):
  the native-agent hook (the 500/1,500 ms cadence, unchanged),
  [`useFilesPanel`](../../apps/web/src/hooks/useFilesPanel.ts) and the
  multi-review reviewer tab, among others. Backend work and monitoring continue
  regardless of the renderer.
- **Batched backend activity reads** (step 17, backend half). The two-second
  activity sweep reads HTTP bridges through `POST /sessions/activity` in bounded
  chunks (at most 64 sessions per request) instead of one request per session,
  with the same no-touch contract as `GET /session/:id/activity`; older bridges
  fall back to individual reads with bounded concurrency. See
  [`session-activity-batch.ts`](../../packages/protocol/src/session-activity-batch.ts).

## Problem (remaining)

Hidden documents no longer poll, but a visible client still reads at the fixed
foreground cadence: 500 ms during active native-agent phases, 1,500 ms while
idle, and five seconds for an open files panel. On mobile or constrained
connections, request overhead and frequent updates can still consume data and
battery after payload sizes are reduced, and there is no user control for it.

## Proposed work (optional preference and backoff)

- Add a device/client-local data-saving preference. It must not change a shared
  backend's cadence for other connected clients. Persist it through the existing
  client-settings mechanism and expose a clear user control.
- Feed it into the existing read coordinator as one more scheduling input rather
  than adding independent timers per feature. Treat network hints as optional;
  do not assume every browser has them or that they accurately identify metered
  access.
- Trial a one-second active refresh and progressive idle backoff to 5–15 seconds.
  These are experiment values, not established defaults. Reset backoff on user
  action, a relevant invalidation, reconnect, or return to visibility.
- Keep approvals, completion, errors, queue/dispatch controls, and safety state
  responsive through reliable invalidations. Retain a recovery poll until every
  provider's backend monitoring has demonstrated complete event coverage.
- Use small status/interaction reads where necessary; do not fetch history just
  to keep an activity indicator or prompt current.
- Reduce or detach hidden terminal presentation subscriptions only when exact
  snapshot recovery is available. Unsubscribing a view must never terminate the
  terminal or agent process.

## Likely implementation locations

- `apps/web/src/lib/read-coordinator.ts` (the shared scheduler; add the
  preference as an input here)
- `apps/web/src/hooks/useNativeAgentSession.ts`, `apps/web/src/hooks/useFilesPanel.ts`
- `apps/web/src/components/terminal/TerminalContainer.view.tsx`
- Existing client preference store/settings UI, to be identified before editing

## Acceptance and measurement

- [ ] Data-saving preference affects only the requesting client.
- [x] Hidden views stop scheduled presentation reads without cancelling work
      (read coordinator, `0ba8628e`).
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
