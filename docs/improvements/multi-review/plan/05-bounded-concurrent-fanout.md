# Step 05 — Bounded concurrent fan-out

Status: 🟨 Implemented on branch; pending review and merge

Depends on: Steps 02, 03, and 04

## Outcome

Overlap independent provider setup, preparation, prompt dispatch, and running
status observations within explicit limits. Preserve exact per-reviewer dispatch
journalling, workflow fencing, deterministic state merges, provider isolation,
and workflow-fatal package semantics.

This is the central architecture change. Do not implement it as
`Promise.all(reviewers.map(advanceReviewer))`: the current runner mutates one
shared workflow and saves whole revisions, so naive concurrency creates lost
updates and can break the `dispatching -> send -> sent` safety boundary.

## Execution model

Split reviewer advancement into two layers.

### Reviewer task

A task receives an immutable snapshot containing reviewer ID, reviewer/session
generation, workflow generation, controller token, provider capability handle,
and verified evidence generation. It may perform provider I/O and returns typed
effects/patches. It never saves the workflow directly and never mutates another
reviewer.

### Workflow commit coordinator

One coordinator per active workflow serializes canonical mutations. For every
commit it:

1. checks the controller token/fence and workflow generation;
2. checks that the target reviewer/session generation still matches;
3. applies a field-scoped patch to the newest canonical workflow;
4. validates invariants and increments the revision;
5. performs an immediate safety save or stages an observation; and
6. returns the committed reviewer snapshot used by the next operation.

The coordinator is bounded by reviewer count, drained on shutdown, and rejects
new work after fence loss or cancellation.

## At-most-once dispatch sequence

Each reviewer task follows this exact sequence, even while other reviewers are
doing the same sequence concurrently:

1. Allocate/reuse the stable request ID and commit `prepared` if needed.
2. Commit `dispatching` as an immediate safety transition.
3. Recheck cancellation/fence from the commit result.
4. As the next reviewer-local fallible operation, call `sendPrompt` once with
   that request ID. Do not insert status, transcript, model, or filesystem I/O.
5. Commit `sent` on an explicit accepted response.
6. On timeout/disconnect/unknown response, leave an ambiguous/parked dispatch
   for explicit same-ID reconciliation. Never resend under a new ID.

Parallel activity by other reviewer tasks does not violate “next operation”:
the rule is scoped to the reviewer journal. The coordinator must not run another
fallible action on that reviewer between steps 2 and 4.

## Concurrency and fairness

- Add separate bounded semaphores for admission I/O and observation I/O.
- Choose initial defaults from Step 01. Make limits backend configuration with
  conservative hard maxima, not unbounded user input.
- Support an optional per-provider cap so one bridge or account cannot be
  flooded by a 32-reviewer panel. Group by provider instance/platform without
  putting credentials into keys or metrics.
- Preserve reviewer list order for initial admission fairness. Completion order
  may differ and must not determine final report ordering.
- A retryable setup error schedules only that reviewer for retry; it must not
  return from the entire pass before later reviewers are admitted.
- Cancellation has priority over queued admission. Queued tasks are removed;
  in-flight sends follow their existing ambiguous-dispatch resolution.
- Never hold the workflow commit queue or a storage lock while awaiting provider
  I/O.

## State model and UI projection

The existing `pending` status can represent concurrency waiting, but the UI
needs to distinguish healthy queueing from a provider retry. Add optional,
backward-compatible reviewer fields only if measurements show queue time is
visible enough to matter, for example:

```text
admissionState?: "queued" | "starting" | "retrying"
admissionReason?: fixed enum
queuedAt?: ISO timestamp
```

Do not persist free-form provider errors as an admission reason. Older workflows
without these fields remain valid. Clear queue metadata on running/terminal
transition.

## File-level work

- `apps/backend/src/core/review-fanout.ts`: extract the reviewer state machine,
  typed effects, semaphores, and coordinator-facing host contract.
- `apps/backend/src/core/multi-review-service.ts`: own the canonical workflow
  coordinator and map package-fatal outcomes to workflow failure.
- `apps/backend/src/core/build-pipeline-review-fanout.ts`: adapt stage state to
  the same coordinator contract; do not fork a second concurrency algorithm.
- `packages/protocol/src/review-fanout.ts`: add optional queue projection fields
  and validators only if selected.
- `packages/protocol/src/multi-review.ts` and `build-pipeline.ts`: propagate the
  shared records without owner-specific duplicates.
- Reviewer overview components: render queued/starting/retrying as status text,
  not as a false running state.

## Error semantics

| Event | Scope | Required result |
| --- | --- | --- |
| Package/snapshot verification failure | Workflow/stage | Stop admission; abandon live work; fail owner |
| Provider create/prepare retryable error | Reviewer | Keep pending/retrying; continue other tasks |
| Prompt send ambiguous | Reviewer | Park same request ID; continue safe reviewers |
| Status/transcript read transient error | Reviewer observation | Preserve prior state; retry when due |
| Structured result invalid after repair | Reviewer | Fail reviewer; retain other reports |
| Controller fence lost | Whole coordinator | Reject commits; stop starting I/O; new owner reconciles |
| User cancellation | Whole owner | Cancel queued work; decline/abort live sessions safely |

## Test matrix

Use controllable deferred provider methods and a deterministic task scheduler.
Cover:

- maximum observed setup concurrency never exceeds global or provider cap;
- two slow admissions overlap and dispatch skew shrinks by the expected wave
  count;
- reviewer output order remains configuration order despite reverse completion;
- a retryable reviewer does not block later reviewers in the same pass;
- safety commits from simultaneous reviewers preserve both updates;
- stale observation patches cannot overwrite a replacement session;
- fence loss at every dispatch boundary prevents stale commits;
- cancellation while queued, creating, prepared, dispatching, sent, and running;
- one workflow-fatal package error stops all waves;
- one reviewer/provider failure does not cancel peers;
- service restart reconciles all intermediate states without duplicate sends;
- 32 reviewers keep task, patch, and semaphore queues within explicit bounds;
- standalone and Build Pipeline owners produce equivalent traces.

Add randomized/state-machine tests that interleave commit resolution, provider
completion, cancellation, fence loss, and restart. Seed failures for replay and
keep the default iteration count CI-safe.

## Acceptance criteria

- Admission wall time follows `ceil(reviewers / cap)` waves rather than the sum
  of all setup durations in the synthetic benchmark.
- No concurrency limit is exceeded, including per-provider limits.
- Dispatch/recovery tests prove no duplicate prompt under every injected crash
  and ambiguity point.
- No whole-workflow lost update under concurrent reviewer completion.
- Retryable setup no longer blocks unrelated reviewers.
- Output and consolidation source ordering are deterministic.
- Both owners use the one shared algorithm and pass the same conformance suite.

## Implementation record

- `review-fanout-scheduler.ts` provides `runBoundedTasks`. It has separate
  admission and observation pools, a per-provider-platform cap, list-order
  starts, and a stop signal honoured before each start. Defaults are
  admission 4, observation 8 and per-provider 4, clamped to [1, 16].
  Configuration: `reviewFanoutConcurrency` on both services; set all to `1`
  to restore serial behaviour.
- `ReviewFanoutRunner.advanceReviewers` runs one isolated task per unsettled
  reviewer:
  - A retryable setup failure, an ambiguous dispatch or a queued repair affects
    only that reviewer.
  - A snapshot/evidence fault or a lost fence stops new starts, lets in-flight
    calls settle, and is rethrown. A snapshot fault first abandons live
    sessions.
- The at-most-once sequence is unchanged per reviewer: `dispatching` is
  committed and awaited, then `send` is the next reviewer-local fallible call,
  then `sent` is committed. A schema repair now retires the superseded result
  slot before the new request identity reaches memory, so a peer's commit
  cannot persist it early.
- Deliberate difference from the plan's coordinator: reviewers share the
  owner's in-memory record, and every write is serialized, instead of
  field-scoped patches merged into a canonical copy. Each write persists
  complete synchronous state. The per-reviewer journal ordering is what the
  safety rule needs, and the tests assert it under concurrency.
- Not added: `admissionState`/`queuedAt` protocol fields. At the default caps
  the measured queue time is one setup wave (tens of ms in the benchmark), so
  per the plan's "only if measurements show" condition they were left out.
- Tests: `review-fanout-efficiency.test.ts` covers:
  - caps, including per-provider, and list-order starts;
  - 32 reviewers within bounds, each dispatched once;
  - `dispatching` durable before each send;
  - a retryable failure and an ambiguous dispatch isolated from peers;
  - a fence loss stopping admission;
  - a snapshot fault abandoning all live reviewers;
  - no overlapping saves.

  The benchmark measures wave-shaped admission.
- Not done: randomized state-machine interleaving tests.
