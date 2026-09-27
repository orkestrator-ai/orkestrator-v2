# Step 02 — Lazy transcript observation

Status: 🟨 Implemented on branch; pending review and merge

Depends on: Step 01

## Outcome

Make progress throttling prevent provider transcript I/O. A running reviewer is
still checked for status and stalls, but its transcript is read no more than
once per `DEFAULT_PROGRESS_PROBE_INTERVAL_MS` unless a separate result or usage
path demonstrably needs it.

This is the lowest-risk high-value change: it fixes accidental eager work while
preserving the one-second supervision semantics used before Step 06.

## Current issue

`ReviewFanoutRunner` currently starts `provider.messages()` before passing a
closure to `MultiReviewProgressTracker.observe`. The tracker can throttle its
comparison, but cannot prevent the already-started request. The interactive fix
path in `multi-review-service.ts` already demonstrates the desired lazy shape.

## Design

Introduce one pass-local transcript loader per reviewer:

```text
loadTranscript()
  first caller -> provider read -> memoized promise
  later caller in same reviewer advance -> same promise
  no caller -> no provider request
```

The progress tracker receives `() => loadTranscript(tail=1)`. Usage settlement
may request a larger bounded snapshot only if usage is absent from the status or
result response. Do not reuse a one-message tail as though it were a complete
result transcript.

The memoization lifetime is one invocation of the reviewer state machine. Never
retain content-bearing transcript data in the workflow, shared runner, metrics,
or cross-pass cache. Only the existing fixed-size digest remains durable.

## Implementation tasks

- [ ] Refactor the running-reviewer branch in
  `apps/backend/src/core/review-fanout.ts` so no promise is created before
  `progress.observe` decides a probe is due.
- [ ] Add a small pass-local loader that memoizes identical bounded requests.
  Key it by read shape (for example tail count/source token) so a tail read is
  not accidentally reused for a full result parse.
- [ ] Keep the progress failure contract: a rejected transcript read yields
  `probed: false`, does not fail the reviewer, and records the attempt time so a
  broken bridge is not hammered every tick.
- [ ] Continue evaluating the durable `progressAt`/`startedAt` stall clock when
  a probe is throttled or fails.
- [ ] Call `progress.forget(sessionId)` on every terminal path, replacement
  session, cancellation, and reviewer deletion.
- [ ] Confirm the Build Pipeline host supplies the same lazy callback and does
  not prefetch through a host adapter.
- [ ] Add instrumentation counters for `probe_due`, `probe_throttled`,
  `provider_read_started`, `provider_read_failed`, and `pass_local_reuse`.

## Failure and restart behavior

- A backend restart loses the in-memory probe timestamp. The first post-restart
  probe may read once and compares against the persisted digest; this is correct
  and bounded.
- A transcript read failure is not evidence of progress or stalling. The
  durable time clock continues, so repeated unreadability can still reach the
  existing warning/abandon thresholds.
- A session-generation change must discard the prior loader and tracker entry.
- Cancellation must not await a transcript request that was never needed.

## Tests

Extend `multi-review-progress.test.ts`, `review-fanout-dispatch.test.ts`,
`multi-review-service.test.ts`, and the Build Pipeline fan-out tests to prove:

1. ten supervision passes inside 60 seconds produce one transcript provider
   call, not ten;
2. advancing beyond 60 seconds produces exactly one new call;
3. concurrent progress and usage consumers with the same read shape share one
   request;
4. different read shapes do not share an incomplete response;
5. a rejection is swallowed for progress purposes and retried only after the
   interval;
6. the persisted digest detects a changed transcript after tracker recreation;
7. a settled/cancelled/replaced session is forgotten; and
8. reviewer status, report settlement, and stall abandonment remain unchanged.

Use a deferred provider mock to assert the request has not merely been hidden
behind an unawaited promise: its call count must stay zero on throttled passes.

## Acceptance criteria

- Baseline counter: throttled observations produce zero transcript network
  calls and zero response bytes.
- At most one progress transcript read per live session per configured interval,
  aside from explicitly separate result/usage reads.
- No transcript content is retained beyond the pass.
- Existing dispatch, settlement, cancellation, and stall behavior passes for
  both workflow owners.
- No protocol or UI change is required.

## Implementation record

- `PassTranscriptReader` (`review-fanout-transcript.ts`) replaces the eager
  `provider.messages()` call. It lives for one reviewer advance, starts no read
  until a consumer asks, memoizes by read shape, and lets a smaller tail reuse
  a larger read, never the reverse.
- The progress probe asks the tracker whether a probe is due
  (`MultiReviewProgressTracker.isProbeDue` / `nextProbeAt`). A throttled pass
  starts no provider request.
- Transcript-derived usage now shares the one due read, sized for usage. It is
  refreshed on the probe cadence rather than every pass. Terminal/settling
  paths still read usage once when the provider supplied none.
- Build Pipeline: the lazy reader is passed to `onReviewerObserved`, so the
  pipeline mirror reads the transcript only when the persist throttle is due,
  the session status changes, or the turn is settling (so the final transcript
  is kept).
- Tests: `review-fanout-efficiency.test.ts` — ten passes in 60 s read once;
  +60 s reads once more; a failed read is swallowed and retried only after the
  interval; usage shares the read; a replaced session starts a fresh clock.
  Existing tests that asserted a read on every pass were updated to the new
  contract.
