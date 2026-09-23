# Multi Review efficiency review

Date: 2026-09-21

Status: Recommendations implemented on the `multi-review-efficiency` branch. See the
[implementation plan](plan/00-index.md) and [measured results](plan/baseline.md).

## Executive summary

Multi Review has a sound correctness-oriented design. It captures one snapshot,
runs final validation once, seals shared evidence, starts independent read-only
reviewers, and consolidates their structured reports with traceable provenance.
The backend remains authoritative when the UI is inactive, and dispatches are
journalled so an optimization does not have to trade away reliability.

The default two-reviewer case is reasonable, but the implementation does not
scale cleanly toward the supported maximum of 32 reviewers. The model work is
parallel after each prompt is accepted, while admission, package verification,
status observation, and persistence remain substantially serial and linear in
the reviewer count. The most important inefficiencies are:

1. The complete review package and its validation artifacts are re-verified for
   every reviewer and again for consolidation.
2. Reviewers are created, prepared, dispatched, and observed one at a time.
3. Reviewer transcript reads are started on every one-second supervisor pass,
   despite the progress tracker having a 60-second probe interval.
4. Small progress changes repeatedly rewrite the complete workflow store,
   rotate backups, announce a resource change, and make clients refetch the
   workflow.
5. Consolidation receives every complete report, including repeated scope,
   test, and change-summary fields, with no report-level or aggregate prompt
   budget below the 32 MiB workflow cap.

The best first release is a control-plane optimization, not a change to review
quality: verify immutable evidence once, use bounded concurrent reviewer
admission, make transcript reads genuinely lazy, and checkpoint observational
state once per pass. These changes should materially reduce latency, bridge
traffic, filesystem churn, and UI resync traffic without changing which models
run or what they are asked to review.

## Scope and method

This review traced the manual Multi Review path across:

- workflow protocol and validation;
- package preparation and integrity verification;
- reviewer fan-out and provider supervision;
- structured report consolidation;
- workflow persistence and resource-change publication;
- the overview and reviewer transcript tabs; and
- the owning unit and browser tests.

This is a static code-path review, not a production benchmark. A small prompt
measurement using the repository's generated-package fixture produced a
representative packaged-reviewer prompt of 5,935 characters. The accompanying
structured report schema serializes to 9,798 characters. Those figures are
useful for showing fixed per-reviewer overhead, but they are not token or cost
measurements and will change with the prompt contract.

## Current pipeline

The normal path is:

1. Capture the worktree identity.
2. Ask the preparation/consolidation model to discover a validation plan.
3. Run the plan once in the environment-owned validation worker.
4. Generate one package containing the pinned review range and validation
   evidence references.
5. Start each reviewer in an isolated, read-only provider session.
6. Wait for every non-stopped reviewer to settle.
7. Send all usable structured reports to one consolidation turn.
8. Optionally hand the consolidated findings to a separate Fix session.

The intended wall-clock shape is approximately:

`preparation + validation critical path + slowest reviewer + consolidation + optional fix`

The current control plane adds reviewer-count-dependent work around the
reviewer term. For `R` reviewers and `A` bytes of package plus validation
artifacts, the notable scaling terms are:

- evidence hashing: approximately `(R + 1) * A` before reviewer dispatches and
  consolidation;
- reviewer admission latency: the sum of `R` create/prepare/send sequences,
  rather than bounded concurrent waves;
- running supervision: at least `R` status and interaction checks per pass,
  plus transcript and fence reads; and
- consolidation input: the sum of all complete report sizes.

## What is already efficient

Several important choices should be preserved:

- Validation runs once and its artifacts are shared. Reviewers are explicitly
  told not to rerun full test, typecheck, or build commands.
- Safe validation commands can overlap under a bounded, resource-aware worker.
- The package pins the evidence all reviewers must use, avoiding independent
  reviews of different worktree states.
- Provider instances are shared by environment and platform, avoiding one
  bridge client per reviewer.
- The preparation and consolidation turns reuse a provider session when their
  model selection permits it.
- Dispatch state, request IDs, schema repair, controller leases, cancellation,
  and stalled-session handling are durable. Background work does not depend on
  a mounted React component.
- Reviewer failure is isolated; one failed reviewer does not discard reports
  from the rest of the panel.
- The UI only polls a reviewer transcript while that nested tab is active.

These are the feature's load-bearing guarantees. The recommendations below are
designed to reduce duplicate work around them, not replace them.

## Findings and recommendations

### 1. Package integrity verification multiplies evidence I/O by reviewer count

Priority: highest

For a packaged review, `reviewerPrompt` calls
`assertReviewPackageIntegrity` immediately before every reviewer prompt
([multi-review-service.ts](../../../apps/backend/src/core/multi-review-service.ts#L2197)).
Consolidation verifies the package again. Verification reads the package,
hashes it, parses it, and verifies every referenced validation artifact
([commands-review.ts](../../../apps/backend/src/core/commands-review.ts#L725)).
The service test explicitly expects three verification calls for two reviewers:
one per reviewer plus one for consolidation
([multi-review-service.test.ts](../../../apps/backend/src/core/multi-review-service.test.ts#L6204)).

This can dominate local I/O when validation captured large logs. The validation
design allows hundreds of MiB of bounded evidence, so repeatedly hashing it is
not a micro-optimization.

Recommended design:

1. Make the sealed package generation an actual immutable-storage boundary.
   Store the package and artifacts in a backend-owned, content-addressed area
   and expose them read-only to reviewer sessions. A content address plus a
   read-only mount lets the backend verify at sealing and trust the same object
   for every dispatch.
2. Until that exists, verify once for one fan-out admission generation, then
   dispatch that generation's reviewers in a bounded concurrent wave. Verify
   again before consolidation. This reduces `R + 1` full verification passes to
   two while retaining a check at both phase boundaries.
3. Do not use a path/mtime-only cache as the final design. Same-size replacement
   and timestamp manipulation are exactly why the current code hashes content.

The phase-boundary interim option slightly widens the time between verification
and an individual prompt. It should therefore be paired with read-only package
permissions and a generation identifier, and replaced by backend-owned
immutable storage when practical.

### 2. Fan-out admission and observation are serial

Priority: highest

`advanceReviewers` awaits `advanceReviewer` inside a plain loop
([review-fanout.ts](../../../apps/backend/src/core/review-fanout.ts#L690)). One
reviewer is created, policy-resolved, package-verified, attached, durably marked
dispatching, sent, marked sent, checked for interactions, and status-read before
the next reviewer is touched. The model turns overlap after dispatch, but later
reviewers start with avoidable skew.

The serial loop also creates head-of-line blocking:

- a slow create, attach, send, interaction, or status call delays every later
  reviewer;
- a retryable policy or dispatch-setup failure returns from the entire pass,
  leaving later reviewers untouched
  ([review-fanout.ts](../../../apps/backend/src/core/review-fanout.ts#L711)); and
- one slow reviewer observation holds the workflow lock and delays observation
  of the rest of the panel.

Recommended design:

- Split the runner into explicit `admit`, `dispatch`, `observe`, and `settle`
  operations per reviewer.
- Run independent operations with bounded concurrency, for example a global
  per-environment limit plus a smaller per-provider limit. Do not launch all 32
  sessions without a cap; that merely moves the bottleneck into provider rate
  limits and local agent processes.
- Preserve the existing per-reviewer at-most-once sequence:
  persist `dispatching`, make `send` the next fallible operation, then persist
  `sent`. Concurrency must be across reviewers, never across those three steps
  for one reviewer.
- Treat a retryable setup failure as that reviewer's pending work and continue
  admitting or observing other reviewers.
- Add a visible queued/admitting state or reason so a bounded scheduler is
  understandable when the panel is larger than its concurrency budget.

A useful wall-clock target is for dispatch skew to be bounded by the number of
concurrency waves, not by the full reviewer count.

### 3. The reviewer progress throttle does not throttle transcript I/O

Priority: highest

The progress tracker is configured to read a running session's transcript at
most once per 60 seconds
([multi-review-progress.ts](../../../apps/backend/src/core/multi-review-progress.ts#L38)).
However, reviewer supervision calls `readReviewerMessages` before invoking the
tracker. That function immediately starts `provider.messages(...)` for every
running reviewer
([review-fanout.ts](../../../apps/backend/src/core/review-fanout.ts#L1079)). The
already-started promise is then handed to `progress.observe`, whose early
throttle return cannot undo the request
([review-fanout.ts](../../../apps/backend/src/core/review-fanout.ts#L1164)).

The preparation/consolidation/fix-session path already shows the better shape:
it creates the transcript promise inside the callback that the progress tracker
invokes only when a probe is due
([multi-review-service.ts](../../../apps/backend/src/core/multi-review-service.ts#L2270)).

Recommended design:

- Pass a lazy transcript reader into progress and usage handling instead of an
  eager promise.
- If an authoritative status observation already contains cumulative usage,
  do not read a transcript for metering.
- When transcript-derived usage is required, share the one due transcript read
  between usage and progress, as the fix-session path does.
- Add a default-interval regression test proving that several one-second
  reviewer passes cause one transcript read, not one read per pass. Existing
  throttle coverage exercises the fix-session path, not the fan-out path.

This is likely the smallest change with the clearest immediate reduction in
bridge and network traffic.

### 4. One-second polling performs more work as a pass becomes slower

Priority: high

The service scans all workflows every second
([multi-review-service.ts](../../../apps/backend/src/core/multi-review-service.ts#L448)).
If another interval fires while a tick is active, `requestTick` sets `pending`
and immediately repeats after the current pass
([multi-review-service.ts](../../../apps/backend/src/core/multi-review-service.ts#L1428)).
Once an `R`-reviewer pass takes longer than one second, the service can run
continuously rather than waiting before the next observation.

Every running reviewer can perform an interaction-list read, a status read,
multiple controller-fence validations, and the transcript read described above.
Most of this state does not need one-second precision for a review that runs for
minutes.

Recommended design:

- Replace the global fixed scan with per-workflow due times and immediate wakeups
  for user actions, dispatch completion, result submission, and provider events.
- Use a short cadence only while admitting or settling a turn. Back off running
  reviewer observation to a few seconds, with jitter across workflows.
- Use interaction watchers where providers expose them, plus a bounded snapshot
  reconciliation on attach/restart. Do not make events the only source of
  truth.
- Never run a catch-up pass immediately merely because a timer fired during a
  slow pass; schedule from completion with a minimum delay.
- Add a provider-level batch observation capability where one upstream snapshot
  can report several sessions. Fall back to individual reads for providers that
  cannot do this.

The scheduler must still rehydrate from durable workflow and provider snapshots
after a restart. Events are an optimization and wakeup signal, not authority.

### 5. Observational changes create write, backup, and UI-refetch amplification

Priority: high

The fan-out runner saves repeatedly during admission and completion, which is
required around ambiguous dispatch boundaries. It also saves token and progress
observations while reviewers run. Each workflow save loads the complete
`multi-reviews.json`, replaces one record, rewrites the complete file, and
announces a resource change
([storage-reviews.ts](../../../apps/backend/src/core/storage-reviews.ts#L510)).
Sensitive JSON writes rotate backups by default; the storage implementation
notes that a backed-up high-churn write costs about 13 extra filesystem
operations
([storage-base.ts](../../../apps/backend/src/core/storage-base.ts#L1248)). Every
announcement makes the web client refetch the workflow
([store-resource-sync.ts](../../../apps/web/src/lib/store-resource-sync.ts#L619)).

Controller fence checks and lease renewals also read or rewrite the same complete
workflow store. The fan-out path invokes fence validation repeatedly around
provider I/O, correctly, but pays full JSON parsing and mutation-lock contention
for each check.

Recommended design:

- Keep immediate durable writes for safety-critical transitions: session
  identity, prepared/dispatching/sent, accepted result, terminal state,
  cancellation, and controller ownership.
- Accumulate non-critical observations across all reviewers in one pass and
  checkpoint once: token counters, progress digest/time, and stall presentation
  metadata. Flush them immediately when a reviewer settles or the service shuts
  down.
- Debounce/coalesce resource announcements so clients receive the newest
  revision once per observation window while still receiving structural
  transitions immediately.
- Separate controller leases into a small high-churn store or equivalent
  transactional record. Lease renewal should not rewrite every retained review
  report, and a fence check should not parse all historical workflows.
- Consider one file/record per workflow or a small transactional database so
  updating one active workflow is independent of retained workflow history.
- If volatile observation fields remain file-backed, use the storage layer's
  no-backup mode only for a separately recoverable projection. Do not disable
  backups for the authoritative dispatch journal.

A good invariant is at most one observational workflow write and one resource
announcement per scheduler pass, independent of reviewer count. Dispatch
journalling writes are intentionally exempt.

### 6. Reviewer transcript UI reads are bounded after retrieval, not at retrieval

Priority: medium

The reviewer tab polls every four seconds while active and describes each poll
as a whole-transcript read
([MultiReviewReviewerTab.tsx](../../../apps/web/src/components/review/MultiReviewReviewerTab.tsx#L42)).
The backend calls `provider.messages(sessionId)` with no limit, then keeps the
last 500 entries
([multi-review-service.ts](../../../apps/backend/src/core/multi-review-service.ts#L495)).
For HTTP bridge providers, the legacy message implementation reads the complete
transcript before applying a supplied limit, so even adding the existing limit
argument is only a partial improvement for those bridges.

Recommended design:

- Use the provider's bounded `transcriptSnapshot` surface with a source token,
  message count, and byte target, matching the progressive native-agent path.
- Return `unchanged` when the source token is current instead of serializing the
  same 500 messages every four seconds.
- Retain polling as snapshot recovery, but wake the active tab from provider or
  resource events so normal updates are incremental.
- Make both message count and bytes explicit. A small count can still contain a
  very large tool result.

### 7. Consolidation input grows without a useful lower-level budget

Priority: high for large panels; medium for the default panel

`consolidationReports` copies every complete structured report
([review-fanout.ts](../../../apps/backend/src/core/review-fanout.ts#L297)), and
the prompt serializes that array directly
([multi-review-prompts.ts](../../../apps/backend/src/core/multi-review-prompts.ts#L82)).
The structured-review validator checks types and consistency but does not bound
string lengths or array lengths
([validation.ts](../../../packages/protocol/src/structured-review/validation.ts#L101)).
The workflow store has a 32 MiB snapshot cap, but that is far above a practical
single model prompt and applies only when the full snapshot is saved.

Every reviewer repeats common material such as review scope, change summary,
risk profile, test results, and verdict. Much of that is identical or derivable
from the shared package. At 32 supported reviewers
([review-fanout.ts](../../../packages/protocol/src/review-fanout.ts#L22)), the
consolidation turn can become expensive or exceed a provider context before the
workflow reaches its persistence limit.

Recommended design:

- Add protocol bounds for report bytes, issue count, coverage-gap count, list
  lengths, and individual strings. Keep the provider schema and runtime parser
  aligned.
- Enforce an aggregate consolidation-input budget before dispatch and surface a
  recoverable, actionable error instead of relying on a provider context error.
- Build a compact consolidation envelope: include shared package/scope/test
  facts once, then include per-reviewer findings, coverage gaps, strengths,
  limitations, commentary, and only genuinely differing claims.
- Preserve every backend-issued source ID through compaction. Never truncate
  findings silently.
- If large panels must remain supported, use bounded hierarchical
  consolidation. Intermediate merges must retain all source IDs, and the final
  backend provenance validation must still reject missing or invented IDs.

### 8. Prompt layout misses prefix-cache reuse

Priority: medium

The long reviewer contract is almost identical across reviewers, but the first
line contains the reviewer number and count
([multi-review-prompts.ts](../../../apps/backend/src/core/multi-review-prompts.ts#L155)).
That makes the prompt differ at the beginning rather than after the invariant
instructions. Providers that cache identical prompt prefixes cannot reuse the
large shared prefix as effectively.

Recommended design:

- Put the stable safety, package, workflow, and output instructions first.
- Put reviewer number, count, request capability, and any diversity assignment
  in a short suffix.
- Keep the exact stable prefix byte-identical for reviewers using the same
  contract version. Measure provider-reported cached-input usage where
  available; do not assume every provider supports prefix caching.
- Reduce prose that mechanically restates the supplied JSON Schema, but retain
  the rules that models have demonstrably violated and the prompt-injection
  boundary.

### 9. The launcher optimizes model count, not marginal review value

Priority: medium

The default is two reviewers, but when a second reviewer default is absent the
launcher duplicates the first reviewer's defaults
([MultiReviewLaunchDialog.tsx](../../../apps/web/src/components/review/MultiReviewLaunchDialog.tsx#L210)).
Exact duplicates may be intentional stochastic sampling, but the UI presents
them simply as separate models and does not explain the cost or expected
diminishing return. The reviewer prompt also requires every reviewer to perform
a complete review and not omit a finding because another reviewer may find it.
That is robust, but maximizes overlap.

Recommended design:

- Warn, but do not reject, exact duplicate platform/model/effort/speed rows.
  Label them as independent samples of the same configuration.
- Offer presets such as Quick (one reviewer), Balanced (two distinct defaults),
  and Thorough (larger panel), while keeping explicit row configuration.
- Show an estimated cost shape before launch: reviewer count, whether package
  preparation and consolidation add two more turns, and whether auto-fix adds
  another turn. Avoid currency estimates unless provider pricing is known.
- Optionally assign broad, non-exclusive review lenses (for example correctness,
  concurrency, tests, or security) to improve diversity. Each reviewer should
  still report any high-confidence issue it finds outside its lens.
- Treat adaptive early stopping as opt-in. If implemented, require a minimum
  panel and a measured novelty/confidence rule; do not silently cancel reviewers
  the user explicitly selected.

## Recommended implementation sequence

### Phase 0: establish a baseline

Add content-free metrics and a repeatable benchmark harness before changing the
scheduler. Record:

- time from `reviewing` to first and last reviewer dispatch;
- reviewer launch skew and per-provider create/prepare/send latency;
- status, interaction, transcript, package-verification, and fence calls;
- transcript and package bytes read;
- workflow writes, bytes written, backup rotations, revisions, and resource
  announcements;
- preparation, validation, reviewer, consolidation, and fix wall time/tokens;
- consolidation input bytes and token estimate;
- schema repairs, stalls, stops, failures, and retry counts; and
- finding novelty: unique consolidated findings versus source finding count,
  using IDs and counts only, never finding text.

Metrics and logs must remain content-free: no prompts, file contents, command
output, credentials, or review text.

### Phase 1: remove accidental repeated work

1. Make fan-out transcript reads lazy and add the missing throttle test.
2. Bound reviewer-tab transcript reads by count and bytes with source tokens.
3. Coalesce observational saves and resource announcements once per pass.
4. Separate or optimize the controller lease store without weakening fencing.

These changes have low product-semantics risk and should make the existing
two-reviewer flow cheaper immediately.

### Phase 2: make fan-out genuinely concurrent

1. Verify package evidence once for the admission generation.
2. Introduce bounded per-environment and per-provider reviewer concurrency.
3. Continue past retryable setup failures instead of blocking later reviewers.
4. Batch provider observations where the provider can do so.
5. Add queued/admitting presentation and cancellation tests.

### Phase 3: control model-context growth

1. Add structured-report and aggregate consolidation budgets.
2. Normalize repeated report fields into one shared consolidation envelope.
3. Move dynamic reviewer data behind a stable prompt prefix.
4. Add bounded hierarchical consolidation only if measurements show that large
   panels are a real supported use case.

### Phase 4: improve review value per token

1. Add duplicate-selection warnings and workflow presets.
2. Measure cross-reviewer finding overlap and unique-finding yield.
3. Trial non-exclusive review lenses or opt-in adaptive stopping against a
   fixed benchmark corpus. Ship only if recall does not regress.

## Verification plan

The performance work should have deterministic tests, not timing-only tests:

- A delayed fake provider proves reviewer 2 can be admitted while reviewer 1's
  independent setup or observation is waiting, within the configured cap.
- A retryable setup failure in reviewer 1 does not prevent reviewer 2 from
  starting or being observed.
- Ten supervisor passes inside the 60-second progress interval produce one
  reviewer transcript read when authoritative usage is available.
- A 32-reviewer running panel has bounded provider concurrency and no unbounded
  promise or queue growth.
- Package verification call and byte counts are independent of reviewer count
  within one admission generation.
- Multiple reviewer usage/progress changes in one pass produce one observational
  checkpoint and one resource announcement.
- Dispatching/sent transitions remain separately durable, and crash/restart
  tests still prove at-most-once prompt delivery.
- An unchanged reviewer transcript returns an `unchanged` snapshot and no
  repeated message payload.
- Oversized individual reports and aggregate consolidation inputs fail with a
  bounded recoverable error before provider dispatch.
- Compacted or hierarchical consolidation retains all valid source finding IDs
  and still rejects invented or missing provenance.
- The inactive-environment scenario remains covered: start a panel, switch
  away, let it finish, return, and recover the same authoritative workflow,
  reports, pending interactions, and controls.

Suggested benchmark cases are 1, 2, 4, 8, and 32 reviewers across one provider
and mixed providers, with small and maximum-size permitted evidence packages.
Report medians and tail latency separately; a single slow provider is precisely
the case bounded concurrency is meant to isolate.

## Success criteria

Set final numeric budgets from the Phase 0 baseline. At minimum, the optimized
design should satisfy these structural criteria:

- package/artifact hashing is constant per phase, not linear in reviewers;
- reviewer admission and observation use explicit bounded concurrency;
- no reviewer transcript is read merely because a throttled probe was skipped;
- running-state observation produces at most one workflow checkpoint and one
  client announcement per pass, excluding dispatch safety transitions;
- lease operations do not parse or rewrite the full review history;
- transcript polling transfers only a bounded changed snapshot;
- every model-bound payload has explicit byte/count limits; and
- efficiency improvements preserve durable background operation, authoritative
  rehydration, at-most-once dispatch, fail-closed interaction handling, and
  exact source provenance.

## Bottom line

The shared validation package is the right architectural center of Multi
Review. The largest gains now come from making that shared object truly cheap to
share and making the fan-out control plane match the parallel shape of the model
work. Optimize verification, supervision, and persistence first. Prompt
compaction and smarter reviewer selection should follow only after metrics can
show their effect on both cost and finding recall.
