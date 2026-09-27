# 07 — Dispatch, queues, and recovery

Status: Implemented (2026-09-24); review gaps closed (2026-09-25); gate evidence partial. Depends on: 02, 03, 06. Milestone: A.

## Deliverable

Deliver a frozen annotation request through the existing native-agent queue,
preserving at-most-once dispatch behavior and visible recovery after uncertain
outcomes. All work must progress without an annotation UI mounted.

## Existing integration points

Extend `native-agent-service-reconciliation.ts` for native queue draining and
request correlation, `native-agent-service-dispatch.ts` for outcome/recovery
integration, and `storage-prompts.ts` / `storage-native.ts` for persisted queue
and dispatch metadata. Inspect the existing queue message validator and shared
storage types before adding origin fields.

Add a proposed `web-annotation-dispatch.ts` adapter that prepares existing native
queue messages and consumes authoritative outcomes. It must not independently
call provider HTTP routes, spawn agents, implement a second dispatch journal,
or use the tmux-only `prompt-queue-drainer.ts`.

## Stable identities and reservations

- [ ] Carry one stable `requestId` through annotation record, queue message,
  native dispatch intent, provider journal, transcript correlation, and result.
  Do not allocate a fresh ID when a send response times out.
- [ ] Include a typed queue origin `{ kind: "web-annotation", requestId }` and
  body hash. Store payload references/frozen data using existing queue limits;
  reject a mismatched request body for an already-used ID.
- [ ] Atomically reserve all selected annotation IDs within the annotation
  manifest when send commits. In A there is one; B must acquire a batch together.
- [ ] Reject competing active implementation requests, including different
  request IDs submitted by two clients for the same annotation revision.
- [ ] Treat a completed request ID as permanently consumed within retained
  request history. Native queue removal/acknowledgement must not make that ID
  eligible for publication again.

## Durable handoff without a distributed transaction

The annotation store and existing native queue do not share an atomic commit.
Implement a recoverable handoff with the following explicit boundaries:

1. Commit the frozen request, implementation reservation, and pending enqueue
   intent in annotation storage. Nothing has been dispatched yet.
2. Publish to the existing queue with an idempotent `enqueueIfAbsent(requestId,
   bodyHash)` extension that checks queued, in-flight, and durable consumed
   identities. Return a receipt for this exact request.
3. Persist that receipt and `queued` state in annotation storage. If this write
   fails, the backend retries the state update, not agent execution.
4. The native drainer uses its existing claim/reservation and dispatch boundary.
   It checks current readiness, compose occupancy, destination, and evidence
   availability before entering the at-most-once window.
5. Record native outcomes and correlated transcript/turn identity. Queue
   acknowledgement and annotation projection updates can be repeated safely.

Recovery inspects the committed enqueue intent, queue/in-flight record, native
dispatch state, and durable consumed receipt. Absence of a queue item alone is
not proof that it was never sent: it may already have been acknowledged. A
missing/unreadable dispatch journal must remain unknown rather than causing
automatic republication.

If an existing storage method cannot atomically deduplicate against a consumed
receipt, add the smallest bounded storage extension and its crash tests before
enabling annotation dispatch. Do not rely on an in-memory set for this fence.

## Queue and session behavior

- [ ] Preserve the native queue's order; an annotation does not jump ahead of
  the user's queued messages or interrupt the current turn.
- [ ] Preserve the current compose-draft occupancy rule. A non-empty native
  draft can hold an annotation request; display **Queued — existing draft needs
  attention** with Open chat/Choose another session. Do not clear it or silently
  exempt annotation-origin messages from the rule.
- [ ] Honor environment setup/readiness, parked dispatches, and session policy.
  Show typed blocked reasons separately from dispatch failures.
- [ ] Reuse best-effort pre-attach where available before entering dispatch.
  Attach failure has not sent the prompt; the ordinary dispatch path remains
  authoritative and uses existing cold-start timeouts.
- [ ] Resolve a destination from persisted tab/session mapping. A closed tab is
  not necessarily a cancelled backend session; distinguish hidden from deleted.
  Do not recreate a deleted destination or attach all idle sessions to poll them.
- [ ] Use backend activity/no-touch APIs or existing activity sweep outputs for
  monitoring. Do not poll `/session/:id` or `/status` in a background reconciler.

## Outcomes and cancellation

| Evidence | Annotation request behavior |
| --- | --- |
| Native dispatch accepted | Record acceptance; remain active even if turn ID/transcript echo has not arrived. |
| Native dispatch explicitly rejected before execution | Show failed/pre-dispatch reason, retain brief/evidence, permit corrected preparation. |
| Timeout, disconnect, unreadable journal, or native unknown | Park as unconfirmed; provide native same-ID recovery and discard actions. |
| Positive provider journal says dispatched | Settle to accepted/running and link actual transcript when available. |
| User removes an unclaimed queued item | Cancel through the atomic queue removal fence, then release annotation reservation. |
| Queue claim races cancellation | Report still active/cancelling; never declare cancelled while a turn may execute. |
| User stops a running request | Reuse existing stop/cancel controls, scoped to the currently correlated turn. |
| User discards unconfirmed recovery | Record abandoned uncertainty and warn that work may have run; do not claim cancellation or retry automatically. |

An old annotation card must not cancel a newer unrelated turn in the same
session. Compare request/turn identity immediately before invoking stop. During
cancelling/recovering, retain active status and reservations until authoritative
settlement or an explicit uncertainty-handling action.

## Backend lifecycle and errors

- [ ] Integrate recovery scans into existing bounded backend lifecycle work.
  Bound scan pages, concurrent sessions, retries, and backoff; isolate failures
  to the affected request.
- [ ] Observe queue removals/edits from the ordinary chat UI and reflect them in
  annotation state. Freeze annotation-origin bodies; editing a queued request
  creates a new revision/request only after safely removing the old one.
- [ ] Attach rejection handlers to every asynchronous notification and abort
  consumer. No stdout loop or provider event callback awaits UI/asset work.
- [ ] Shutdown stops new preparations and flushes owned persistence work with
  deadlines. It does not delete pending requests or mark them failed by default.

## Required fault-injection tests

- [ ] Crash after request commit, after queue write, after provider acceptance,
  after queue acknowledgement, and before annotation state update. Restart must
  produce one execution or a visible unconfirmed state, never a blind resend.
- [ ] Lose a send response and double-click Send from two clients. Same ID/body
  returns the existing request; changed body conflicts; competing IDs conflict.
- [ ] Race annotation cancellation with native queue claim and with an unrelated
  next turn. Verify no incorrect cancellation, reservation release, or auto-retry.
- [ ] Test busy agent, held compose draft, stopped environment, cold attachment,
  missing destination, unsupported assets, and bridge restart/unknown journal.
- [ ] Submit in environment A, switch to B, let work finish, return to A, and
  recover status and transcript correlation without a second execution.

Done when native dispatch remains the only execution authority and every crash
boundary has an explicit, tested reconciliation outcome.
