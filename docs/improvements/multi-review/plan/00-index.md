# Multi Review efficiency implementation plan

Date: 2026-09-21

Status: Implemented on branch `multi-review-efficiency`; pending review, merge, real-stack QA and rollout. Measured results: [baseline.md](baseline.md)

Source review: [Multi Review efficiency review](../README.md)

This plan turns the efficiency review into ten ordered, independently reviewable
implementation steps. The order is intentional: establish measurements first,
remove accidental work without changing orchestration semantics, then introduce
bounded concurrency, and only after that change payloads and product defaults.

The plan covers both owners of the shared fan-out machinery:

- the standalone Multi Review workflow; and
- multi-reviewer stages inside Build Pipelines.

A change to `ReviewFanoutRunner` is incomplete if it is only validated through
one owner.

## Status legend

| Mark | Meaning |
| --- | --- |
| ⬜ | Not started |
| 🟨 | In progress |
| ✅ | Complete and merged to `main` |
| ⏸ | Deferred or blocked; reason recorded in the step |

Update a step's status and this table together. Mark a step complete only when
its acceptance criteria and required validation are satisfied.

Every step is 🟨: its code and focused tests are on the branch, and nothing is
merged to `main` yet. Each step file ends with an implementation record listing
what was done, deliberate deviations, and what is deferred (⏸) or still
pending. Deferred items: provider batch observation (06), hierarchical
consolidation (08), presets and review lenses (09), and the content-addressed
evidence store (04).

## Plan steps

| # | Step | Status | Depends on | Primary outcome |
| --- | --- | --- | --- | --- |
| 01 | [Baseline and performance contract](01-baseline-and-performance-contract.md) | 🟨 | — | Reproducible measurements and content-free operational metrics define success. |
| 02 | [Lazy transcript observation](02-lazy-transcript-observation.md) | 🟨 | 01 | The 60-second progress throttle prevents the provider read instead of merely ignoring its result. |
| 03 | [Persistence and event coalescing](03-persistence-and-event-coalescing.md) | 🟨 | 01 | Safety transitions remain immediately durable; observational churn is checkpointed once. |
| 04 | [Evidence verification generations](04-evidence-verification-generations.md) | 🟨 | 01 | One exact, immutable evidence generation is verified once per phase, not once per reviewer. |
| 05 | [Bounded concurrent fan-out](05-bounded-concurrent-fanout.md) | 🟨 | 02–04 | Provider setup and observation overlap safely while fenced commits preserve at-most-once dispatch. |
| 06 | [Adaptive supervision and provider batching](06-adaptive-supervision-and-provider-batching.md) | 🟨 | 05 | Workflows wake when due or signalled instead of continuously catching up on a global one-second loop. |
| 07 | [Progressive reviewer transcript reads](07-progressive-reviewer-transcript-reads.md) | 🟨 | 01, 03 | Active reviewer tabs transfer bounded snapshots and receive unchanged responses without full-history reads. |
| 08 | [Report budgets and compact consolidation](08-report-budgets-and-compact-consolidation.md) | 🟨 | 01, 04 | Reviewer output and aggregate consolidation input have explicit byte/count limits and no repeated evidence fields. |
| 09 | [Prompt prefix and launcher value](09-prompt-prefix-and-launcher-value.md) | 🟨 | 01, 08 | Prompts have a stable cacheable prefix, while launch UX exposes duplicate configurations and expected work. |
| 10 | [Scale validation, rollout, and cleanup](10-scale-validation-rollout-and-cleanup.md) | 🟨 | 02–09 | The optimized path is proven at scale, rolled out with gates, and old paths are removed deliberately. |

Suggested delivery slices:

1. Steps 01–02 can land as a measurement PR and a low-risk read-elision PR.
2. Steps 03–04 can proceed in parallel after the baseline exists.
3. Step 05 is its own architecture PR; do not mix it with prompt or UI changes.
4. Steps 06–07 may proceed in parallel after the concurrent commit model is
   settled.
5. Steps 08–09 should be quality-evaluated together but remain separate commits
   so payload compaction can be rolled back without reverting UX.
6. Step 10 is the release gate, not a substitute for each step's focused tests.

## Non-negotiable invariants

Every step must preserve all of these properties.

1. The backend owns workflow state. Closing a tab, switching environments, or
   unmounting React does not pause or cancel Multi Review.
2. Provider events are wake-up hints. Authoritative status, transcript,
   interactions, and results are recovered from snapshots after reconnect.
3. For each reviewer, persist `dispatching`, perform the prompt send as the next
   reviewer-local fallible operation, then persist `sent`. Never auto-retry an
   ambiguous send under a new request ID.
4. Controller fencing remains authoritative. A stale controller cannot commit
   reviewer or workflow state after losing its lease.
5. Cancellation, provider disconnect, approval timeout, malformed structured
   output, and generation death fail closed.
6. A package snapshot or integrity failure remains workflow-fatal. A reviewer
   provider failure remains isolated to that reviewer.
7. No queue, transcript response, report, consolidation payload, metric label,
   or log grows without an explicit byte and count bound.
8. Metrics and logs contain no prompt, transcript, report, command, file,
   artifact, credential, token, or attachment content.
9. The shared runner behaves consistently in standalone Multi Review and Build
   Pipeline fan-out.
10. The default two-reviewer result quality must not regress to gain speed.

## Target performance contract

Step 01 records the baseline and converts the following relative goals into
absolute gates. Unless the measurements demonstrate that a target is invalid,
the completed program should achieve:

- one evidence verification per fan-out admission generation and one before
  consolidation, independent of reviewer count;
- no transcript provider request on a throttled progress observation;
- bounded reviewer admission waves, with dispatch skew determined by the
  configured concurrency cap rather than the sum of every setup latency;
- no more than one observational workflow-store checkpoint and one corresponding
  resource announcement per completed supervision pass;
- transcript transfer proportional to the changed bounded tail, not complete
  session history;
- consolidation input bounded independently of the 32 MiB workflow-store cap;
  and
- unchanged dispatch, restart, cancellation, and provenance semantics under
  injected failures.

## Shared verification rule

Each implementation step begins with the owning focused tests, then runs
`mise run test:changed`. Before handoff, run static validation and the complete
non-iOS suite through the repository's logged runner:

```bash
mise run test:logged -- --name check -- mise run check
mise run test
```

Use explicit paths for focused Bun tests and never invoke bare `bun test` from
the repository root. Browser-visible steps also require the component/browser
suite and the inactive-environment cycle described in
[`docs/development/testing-guide.md`](../../../development/testing-guide.md).

## Deliberately deferred

These are not prerequisites for the efficiency program:

- replacing the JSON workflow store with SQLite or one file per workflow;
- semantic reviewer deduplication or automatically cancelling low-value models;
- hierarchical consolidation for every run;
- provider pricing or currency estimates; and
- changing the default panel before quality and cost evidence exists.

They may become follow-ups when the step-01 data supports them. In particular,
do not split the controller lease from workflow state merely to reduce writes:
that would lose the current atomic fence-and-state commit unless both records
move into one transactional store.
