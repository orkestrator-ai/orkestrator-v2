# 02 — Add bounded scheduling and admission mechanics

Status: Primitive landed with tests (`14f4bd0f`); no owner migrated yet —
migrations belong to steps 03, 05, 07 and 08. Dependencies: 01. Findings: F04,
F06.

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

## Completion notes

Landed in `14f4bd0f` (`feat(backend): add bounded recurring scheduler and
admission pools`). No owner was migrated; the step 01 baseline compares with
zero differences (`--compare … --fail-on-change` exits 0).

**What landed**

- `apps/backend/src/core/recurring-scheduler.ts` — `RecurringScheduler`
  (`register`, `update`, `requestSooner`, `invalidate`, `pause`, `resume`,
  `remove`, `has`, `wake`, `dispose`, `status`). Chosen shape: a bounded due map
  scanned linearly per admission pass with one timer for the earliest future
  due time (the baseline population is at most a few hundred keys per owner; a
  heap was not justified). Admission passes run on a microtask, so no run
  starts inside `register`/`invalidate` and a startup batch is ordered as one
  set. Defaults: 1,024 keys (32 reserved for critical/recovery), 4 best-effort
  runs (1 reserved for interactive/recovery), 4 critical runs in a separate
  pool, 256 pending hints per class, starvation cap 8, jitter ceiling 30 s.
- `apps/backend/src/core/work-admission.ts` — `WorkAdmissionPool` with
  `acquire`, `run`, `close`, `status`; pools `git-docker-scan` (4 / 1 per
  target), `external-pr` (2 / 1), `workflow-provider` (8 / 2) per the trial
  table; acquisition order workflow-provider → external-pr → git-docker-scan,
  same-pool hand-off via `holding`, critical requests refused.
- `apps/backend/src/core/recurring-diagnostics.ts` — live schedulers and pools
  register themselves; their content-free status is served with the metrics.
- `apps/backend/src/core/recurring-test-support.ts` — `ManualTime`, `deferred`,
  `flushMicrotasks` for owners' migration tests.

Documented semantics (see the module comment): maximum soft-deadline lateness
is `min(jitterMs, maxJitterMs)` plus timer latency plus waiting for a slot of
the key's class; `requestSooner` while running is dropped by design (use
`invalidate` for a post-change read); a refused hint sets `reconcileRequired`
on the key's next run; aborting a run fences publication but its slot is held
until the run's promise settles.

**Tests** (`recurring-scheduler.test.ts`, `work-admission.test.ts`; manual
clock, deferred promises, no sleeps, 1,175/1,175 passing over 25 repeats):
duplicate/updated/replaced/stale-generation registration; simultaneous
explicit and timer requests; invalidation during a failed read; continuous
dirty input; slow scan resting vs mutation getting a post-change read; two slow
targets with proven peak physical concurrency, including a removed-but-running
operation; key/pending capacity with reserved keys and `reconcileRequired`;
priority with starvation cap; late completion after remove/re-register;
cancellation that does not stop the operation; synchronous throw, rejected
finalizer, faulty retry policy and reported failures with no unhandled
rejections; bounded idempotent dispose reporting still-running work; sleep/
resume and paused-key resume running once; critical renewals on time under a
saturated best-effort pool; reserved concurrency for recovery; bounded jitter
and never-postpone; idle keys; `update`; content-free status; invalid specs.
Admission: overall and per-target bounds, priority and FIFO, starvation cap,
full queue and aborted wait rejection, slot held until the operation settles,
nested order and hand-off, critical refusal, close, queue-delay metrics,
scheduler + pool composition, diagnostics registry.

**Deferred / untested constraints**

- Wiring a real owner (the first migration in steps 03/05/07/08) and comparing
  its step 01 counters before/after; the primitive has no production caller.
- Host sleep detection: `wake()` exists for a resume hook but nothing calls it
  yet; overdue work still runs once when the unref'd timer fires late.
- A shared cooldown by auth/host scope (step 05) and per-owner tuning of the
  trial limits against the live profile.
