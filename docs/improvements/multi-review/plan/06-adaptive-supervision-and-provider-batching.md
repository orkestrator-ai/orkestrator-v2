# Step 06 — Adaptive supervision and provider batching

Status: 🟨 Scheduler implemented on branch; provider batching deferred

Depends on: Step 05

## Outcome

Replace continuous one-second catch-up behavior with a due-time scheduler that
wakes workflows for immediate state transitions, provider signals, user
commands, retries, progress probes, and reconciliation. Batch compatible
provider observations where the provider surface supports it.

## Scheduler model

Maintain one bounded scheduling record per active workflow:

```text
{ workflowId, generation, nextDueAt, reasons: bitset, running, rerunRequested }
```

There is no interval backlog. A workflow already running receives
`rerunRequested`; it runs once more after completion if a reason remains. New due
times are computed from completion, not the prior deadline, to prevent a slow
pass from entering a permanent catch-up loop.

Suggested reason classes and initial timing policy (final values come from Step
01):

| Reason/state | Timing |
| --- | --- |
| User action, provider event, newly dispatchable state | Immediate |
| Dispatch/recovery boundary | Immediate or sub-second bounded retry |
| Running reviewer status | 3–5 seconds with stable per-workflow jitter |
| Progress transcript probe | At tracker's exact next due time, normally 60 seconds |
| Retryable provider setup | Existing retry delay/backoff, with jitter |
| Parked ambiguous dispatch | Reconcile on attach/event/user action plus slow backstop |
| Terminal workflow | Unscheduled |

Jitter is deterministic from a non-sensitive workflow bucket so process restart
does not synchronize every workflow. Do not store or log the source identifier.

## Authoritative state and events

Provider/bridge events are wake hints only. Every event-driven pass reads the
authoritative status/result/interaction snapshot before committing. On backend
restart, bridge reconnect, controller takeover, or expired cursor, schedule an
immediate full reconciliation for every non-terminal owned workflow.

The scheduler belongs in the backend service, not React. UI unmount and inactive
environments do not alter due times.

## Provider batching

Add an optional provider capability such as `observeSessions(requests)` only
where a provider can answer several status/activity/interaction snapshots more
cheaply than individual calls. The shared runner groups due reviewer requests by
provider instance and applies the observation concurrency cap.

- An absent capability falls back to bounded individual calls.
- A batch has count and serialized-byte limits and is split deterministically.
- A batch error degrades to retryable unknown observation, not terminal reviewer
  failure. Do not immediately explode one failed batch into an unbounded request
  storm.
- Results are keyed by the requested opaque session key and generation. Ignore
  missing/duplicate/unrequested entries and reconcile them individually later.
- Settlement operations that need request-specific dispatch journals or full
  results remain individual unless the provider offers equivalent semantics.
- Never change a bridge stdout/read loop so it waits on batching consumers.

## Implementation tasks

- [ ] Replace `setInterval`/catch-up logic in `multi-review-service.ts` with one
  timer for the earliest due workflow plus a bounded ready queue.
- [ ] Expose `requestAdvance(workflowId, reason, dueAt?)` to launch, cancel,
  resume, unstick, provider-event, and resource-reconcile paths.
- [ ] Persist enough workflow state to reconstruct scheduling after restart, but
  do not persist timer internals or append-only reason history.
- [ ] Keep a slow periodic reconciliation backstop for missed events. It uses
  non-touching activity/status routes where required by bridge invariants.
- [ ] Ask the progress tracker for its next eligible probe time, rather than
  waking every second only to learn that it is throttled.
- [ ] Route Build Pipeline fan-out through its existing supervisor scheduler or
  the same due-time primitive; avoid two incompatible timing policies.
- [ ] Add optional batch observation to the provider interface and adapters only
  after measuring which providers benefit.
- [ ] Record pass reason, queue delay, pass duration, batch size, fallback count,
  and missed-event reconciliation using bounded metrics.

## Load and fairness

- Bound globally ready workflows as well as per-workflow reviewer observations.
- Process workflows round-robin when many become due together; one 32-reviewer
  workflow cannot monopolize the service.
- Preserve cancellation priority.
- A provider batch cannot exceed provider/global semaphores established in Step
  05.
- Timer records are removed on workflow terminalization/deletion and rebuilt
  from authoritative storage at startup.

## Tests

With fake timers and providers, prove:

1. a running workflow does not execute a one-second catch-up loop;
2. a provider signal causes an immediate pass and a snapshot read;
3. ten signals during one pass produce at most one requested rerun;
4. a slow pass schedules its next periodic read from completion;
5. progress probes wake at their own due time;
6. startup/reconnect/fence takeover reconcile non-terminal workflows;
7. dropped provider events are repaired by the periodic backstop;
8. terminal/deleted workflows leave no timers or queue entries;
9. batch size/count limits and individual fallback work;
10. one failed batch does not fail reviewers or create a retry storm; and
11. many workflows receive fair progress under the global cap.

## Acceptance criteria

- Provider status call rate for stable running reviewers drops to the measured
  target without increasing result-settlement tail beyond the agreed gate.
- No continuous catch-up pass under slow provider calls.
- Event loss, inactive UI, and backend restart still converge from snapshots.
- Queue, timer, batch, and reason state all have explicit bounds.
- No provider read loop awaits scheduler, renderer, or metric work.
- Standalone and Build Pipeline reviewer supervision follow compatible timing
  and recovery semantics.

## Implementation record

- `multi-review-scheduler.ts` adds `WorkflowDueScheduler`:
  - one due time per workflow, computed from pass completion;
  - no catch-up (a timer never re-runs a running workflow; wakes during a run
    cause at most one rerun);
  - a global concurrency cap of 8 with due-order fairness;
  - a reconciliation scan every 15 s that discovers workflows and forgets
    terminal ones;
  - stable per-workflow jitter.
- `MultiReviewService` uses it by default. Admission, dispatch journals,
  result consumption and cancellation are due 1 s after completion; running
  work every 3 s plus up to 1 s of jitter. User actions call `advanceNow`,
  which runs immediately and then reschedules. Nothing about scheduling is
  persisted; the first scan after start rebuilds it.
- Options: `observationIntervalMs`, `reconcileIntervalMs`; rollback gate
  `adaptiveScheduling: false` restores the fixed interval scan.
- Build Pipeline keeps its existing supervisor, which already joins an
  in-flight pass instead of queueing one; its reviewer passes now use the same
  bounded runner.
- Tests (`multi-review-scheduler.test.ts`): no catch-up under slow passes; ten
  wakes cause one rerun; reconciliation discovery and cleanup; fairness under
  the cap; bounded, stable jitter.
- ⏸ Provider batch observation: deferred. The plan permits it only "after
  measuring which providers benefit". Every current bridge answers status per
  session. The existing `activityBatch` capability reports activity only, not
  the turn settlement, usage and request reconciliation the runner needs.
  Revisit when a bridge exposes a batch status route.
- ⏸ Provider-event wakeups: the service has no provider event subscription
  today; `advanceNow` is the wake entry point for when one is added.
