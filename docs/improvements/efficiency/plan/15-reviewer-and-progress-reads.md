# 15 — Reuse conditional transcripts for reviewers and workflow progress

Status: Not started. Prerequisites: 09, 11. Finding: E13.

## Outcome

Reviewer displays no longer fetch whole legacy transcripts every four seconds.
Supervisors detect meaningful progress without reading megabytes just to hash
one tail. The backend continues monitoring workflows while all views are closed.

## Owners

- [Reviewer service](../../../../apps/backend/src/core/multi-review-service.ts).
- [Progress tracker](../../../../apps/backend/src/core/multi-review-progress.ts).
- [Reviewer tab](../../../../apps/web/src/components/review/MultiReviewReviewerTab.tsx).
- [Pipeline supervisor](../../../../apps/backend/src/core/build-pipeline-service-supervisor.ts)
  and review-fanout consumers of `provider.messages`.
- Native provider contracts/adapters and existing reviewer/progress tests.

## Implementation

1. Inventory display/progress calls to `provider.messages`, including reviewer,
   consolidation, fix-session usage, build review fanout, and feature-planning
   consumers. Classify each as presentation, progress, usage, or semantic result
   extraction. A lightweight summary cannot replace raw data used to recover a
   structured report or exact task evidence.
2. Add a conditional reviewer transcript response carrying a stable view
   identity, token, bounded summary window, and history capability. Reuse the
   native transcript service/adapters without registering a second competing
   agent session or changing workflow ownership/interactions.
3. Update `MultiReviewReviewerTab` to retain its valid base, install snapshots or
   whole-message deltas, and fetch earlier history/details through the common
   endpoints. Preserve read-only presentation, hidden machine-output filtering,
   reviewer attribution, fork/navigation behavior, and existing action controls.
4. Retain the four-second recovery cadence initially; unchanged replies are the
   first optimization. Share concurrent reads and retain scoped invalidations.
   Step 17 controls visibility/backoff so each view does not invent a separate
   scheduling policy. Finished and gone workflows must still stop polling.
5. Define progress observations using source generation, history epoch, and a
   dedicated meaningful-content progress revision/digest. Generic bridge
   revisions may advance for token usage, access time, or status-only events;
   those cannot automatically reset the no-progress clock.
6. Include nested-agent/tool progress and late updates to earlier parts, not
   only the last row. A saturated/truncated display buffer must not make real
   backend work look stalled; the progress signal can advance independently
   of whether display bytes were retained.
7. Preserve persisted progress baselines. When a generation changes, establish
   the new comparison base explicitly without manufacturing a content change.
   Failed/throttled probes mean “nothing learned”; the existing durable stall
   clock continues according to current policy.
8. Fall back to the new bounded tail endpoint when a meaningful progress signal
   is unavailable. Retain a measured legacy fallback only for older bridges.
   Do not widen the 60-second progress-probe cadence into transcript polling on
   every supervisor tick.

## Compatibility and tests

Add capability negotiation for the reviewer read model before changing clients.
Old callers continue receiving their capped snapshot. New clients cache an
unsupported capability per backend generation, not per failed request.

Test running/pending/finished/gone states; inactive view return; stale result
after reviewer replacement; concurrent reviewers sharing a provider; manual
refresh fencing; tool detail expansion; and content hidden for structured
reviews. Prove progress advances for nested activity but not access-time churn.
Run warning/abandonment tests with failed reads and backend restart.

## Acceptance

An unchanged new reviewer read causes no legacy full-history fetch. A changed
read transfers the bounded changed representation. Supervision remains correct
without any reviewer component mounted. Document each semantic consumer left
on an exact/raw path and its bounded read strategy rather than claiming all
`messages()` calls can be eliminated.
