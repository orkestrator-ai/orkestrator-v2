# 04 — Renderer scheduling and failure containment

Status: Planned.  
Dependencies: [02](02-operation-contracts-and-durability.md).  
Findings: R4.

## Outcome

A slow capture, DOM edit, or Chromium startup cannot hold a global document
write lock. Every admitted render has a bounded lifetime, settles its caller,
and leaves the backend able to serve later work after a failure.

## Owners and structure

Modify `design-service.ts` and `design-renderer.ts`; introduce proposed
`design-scheduler.ts` and `design-renderer-supervisor.ts` when their state
machines warrant separate owners. Keep the service API engine-independent.
Tests should mirror scheduling, lifecycle, and commit boundaries separately.

## Scheduling and commit algorithm

1. Authorize and admit the operation under global count/byte limits.
2. Acquire the target canvas lane briefly; capture immutable input plus canvas
   incarnation, frame revision, and document deletion state.
3. Release the commit lock. Perform expensive DOM work through the render
   scheduler; pure geometry/name changes skip Chromium.
4. Reacquire the canvas lane and verify the preconditions again. Commit only
   if the target still matches; otherwise record a conflict and discard the
   computed result. A completed render alone is not a completed edit.
5. Atomically persist result and receipt, release the lane, then publish a hint.

- [ ] Maintain bounded per-canvas sequencing and a small global admission guard
  for create/import quota reservations and environment deletion barriers.
- [ ] Avoid lock inversion: never wait for a renderer while holding a global
  or filesystem commit lock. Define and test lock ordering for two-canvas
  duplication/transfer before adding those operations.
- [ ] Fence in-flight results when a canvas/environment is deleting. A late
  renderer must not recreate a deleted record.
- [ ] Keep metadata reads and operation-status reads independent from render
  lanes. Disk reads may await atomic commits only where consistency requires it.
- [ ] Schedule render jobs fairly across environments/canvases. Allow bounded
  preference for interactive edits over thumbnails, with aging so captures
  and other environments cannot starve.
- [ ] Start with one executing worker and at most sixteen admitted jobs. Admit
  two only after memory/latency measurements establish an improvement.

## Deadline and cancellation contract

Proposed initial budgets: queue wait 15 seconds, browser launch 15 seconds,
context creation 5 seconds, runtime/capture 15 seconds, cleanup 3 seconds,
overall 45 seconds. The effective phase deadline is the earlier of its own
budget and the remaining overall budget. Measure and tune these constants;
never add the phases to justify an unbounded total.

| Phase | Timeout behavior |
| --- | --- |
| Admission/queue | Remove unstarted job, settle as not executed/expired |
| Launch | Terminate only owned browser process tree; clear failed generation |
| Context creation | Retire affected generation if no isolated context can be canceled |
| Runtime/capture | Cancel/close the affected context; bounded escalation if closure hangs |
| Cleanup | Retire/kill only owned browser generation; do not await forever |
| Commit ambiguity | Read durable operation/document state before reporting final outcome |

- [ ] Timers include queue wait and `newContext`, not only page execution.
- [ ] An abort signal has handled consumers; use the fatal-rejection guard only
  as a final floor. Timer callbacks and close/restart promises own their errors.
- [ ] Associate every context/job with a browser generation. Late disconnect
  events from an old process cannot clear a new healthy browser reference.
- [ ] On generation death, fail all affected jobs exactly once and recover the
  scheduler. Do not automatically rerun semantic edits in a new generation.
- [ ] Bound close/shutdown independently of job completion. Stop admission,
  settle queued work, drain within a deadline, then terminate owned resources.
- [ ] If Playwright ownership alone cannot guarantee termination after a hung
  close, use a dedicated owned render worker process with a supervisor. Add
  the repository fatal-rejection guard/watchdog to any new long-lived process.
  Select this based on a demonstrated fault test, not assumptions about APIs.

## Isolation and capture fidelity

- [ ] Preserve isolated contexts, route blocking, disabled service workers,
  download restrictions, trusted runtime CSP, and no authored scripts.
- [ ] Bound request bytes before browser admission and capture bytes before
  base64/transport copies. Count decoded and encoded capture memory.
- [ ] Before capture, wait for permitted data images/fonts and layout readiness
  within the same deadline. Surface timeout diagnostics instead of hanging.
- [ ] Make capture environment deterministic: viewport, device scale, color
  scheme, reduced motion, and runtime version are explicit inputs/cache keys.
- [ ] Health distinguishes missing executable, launch failure, queue saturation,
  running, and recovering. Missing Chromium must not be the message for every
  generic launch exception.

## Required verification

Use deferred launch/context/runtime/close fakes for deterministic unit tests,
then real Chromium against synthetic frames for resource cleanup and sandbox
behavior. Do not interpret a fake browser's resolved close as proof that the
real process terminates.

- [ ] A blocked render on canvas A does not block geometry or status on B.
- [ ] Two edits rendering from the same base result in one commit and one
  conflict, preserving both receipts.
- [ ] Delete environment during a render: no late file resurrection.
- [ ] Flood one environment while another submits an edit: bounded admission
  and demonstrated fairness under the chosen scheduler policy.
- [ ] Hang each lifecycle phase: caller settles within the overall deadline
  plus bounded teardown tolerance, and a later job succeeds.
- [ ] Old-generation disconnect cannot retire the replacement process.
- [ ] Shutdown with active work has no leaked browser/worker or rejection.
- [ ] Remote resources, file reads, navigation, and authored scripts remain
  blocked in both preview and capture paths.

Review slices: per-canvas commit lanes; immutable render/final-CAS boundary;
bounded scheduler; supervised deadline/cleanup; real-browser fault qualification.
