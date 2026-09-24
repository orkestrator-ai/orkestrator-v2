# 02 — Add bounded scheduling and admission mechanics

Status: Not started. Dependencies: 01. Findings: F04, F06.

## Outcome and boundary

Provide a small process-local primitive for keyed due work. Domain services
retain ownership, eligibility, transitions and persistence. Start in the backend;
extract portable pieces only after a second real consumer proves the shape.
The renderer coordinator in step 06 has different demand semantics and should
not share a giant cross-process scheduler.

## Proposed surface

Represent each job by a finite kind plus an internal scoped key, owner generation,
next due time, priority class, running state and a single pending-dirty marker.
Operations should cover register/update, request-sooner, pause, remove, dispose,
and a content-free status snapshot. A run reports success/failure/unchanged and
its next policy deadline; the domain owner decides what that means.

Use an injected monotonic clock, timer factory and deterministic random source.
Use a bounded priority queue or an equivalent bounded due map with one timer for
the earliest due task. Choose based on the baseline population; do not introduce
a heap and complex cancellation bookkeeping without a demonstrated need.

## Implementation tasks

1. Define hard bounds for registered keys, pending keys, concurrent work and
   per-class queues. On capacity exhaustion, reject new registration explicitly
   or mark the owning domain for authoritative reconciliation. Never silently
   drop a required workflow transition. Reserve room for cleanup and recovery.
2. Implement one running operation per key. A periodic tick during a run can be
   skipped; a real invalidation during a run sets one trailing rerun. This
   distinction prevents long-running jobs from executing back-to-back forever
   solely because their interval elapsed while they were busy.
3. Schedule ordinary repeat work from completion. Jitter only soft due times,
   with a documented maximum lateness. Explicit refresh and newly available work
   pull deadlines forward without postponing already earlier work.
4. Add bounded fair admission per work class and target. Begin with separate
   pools for Git/Docker scans, external PR requests and workflow/provider reads.
   Avoid nested acquisition of the same pool: specify acquisition order or pass
   ownership to nested work so saturated pools cannot deadlock.
5. Keep lease renewal, approval expiry, authentication expiry and process watchdogs
   independent. A best-effort scan cannot consume the capacity needed to deny an
   expired approval or renew live controller ownership.
6. Carry generation and cancellation state through every await. Cancellation
   prevents stale publication; it is not evidence that an external operation
   stopped. Release a slot only when the physical operation has settled or its
   bounded transport/child termination is confirmed. A timed-out mutation remains
   the domain's ambiguity problem.
7. Handle errors inside the runner; record a finite error category and ask the
   domain for retry policy. Always own promise rejections, including abort
   consumers and finalizers. Use a bounded shutdown drain and explicit reporting
   for operations still running; never hang backend shutdown indefinitely.
8. On sleep/resume or clock jumps, run overdue work once with fairness, not once
   for every missed interval. Wall-clock timestamps from durable state must be
   translated to fresh in-process deadlines during reconciliation.
9. Make registration/init/dispose idempotent. Removing a key invalidates any late
   callback and clears retained pending state. Metrics should identify the job
   kind, not reveal its scoped key.

## Tests

Use fake scheduling and deferred promises to cover: duplicate registration;
simultaneous explicit/timer requests; invalidation during a failed read;
continuous dirty input; two slow targets; bounded queue saturation; priority
fairness; late completion after remove/re-register; cancellation that does not
stop underlying work; synchronous throw; rejected finalizer; shutdown; and
sleep/resume. Prove maximum concurrent physical operations, not just callbacks.

Test the periodic-versus-dirty distinction explicitly: a scan lasting longer
than its interval should get a rest, while a mutation during that scan must
eventually get a post-mutation read. Prove deadline-sensitive classes remain
responsive under a full best-effort pool.

## Acceptance and rollout

First land the primitive and tests with no migrations. Migrate one service at a
time, retaining its old policy and comparing step 01 counters. Do not replace
all `setInterval` calls mechanically. Rollback restores a migrated owner's
previous driver; it must not restore duplicate drivers or discard durable work.
No new dependency or persistent job store should be needed.
