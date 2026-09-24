# Step 03 — Persistence and event coalescing

Status: 🟨 Implemented on branch; pending review and merge

Depends on: Step 01

## Outcome

Separate safety-critical commits from observational checkpoints. Preserve every
write required for exact recovery, while collapsing token/progress/stall/UI
metadata changes into at most one durable save and one resource announcement
per completed supervision pass.

## Commit classes

### Safety commits — immediate, fenced, durable

Persist before proceeding when a transition changes what may safely happen
after a crash:

- controller acquisition, renewal failure, release, and cancellation ownership;
- reviewer session creation or replacement identity;
- request ID creation and dispatch journal transitions (`prepared`,
  `dispatching`, `sent`, ambiguous/parked, discarded);
- accepted structured result or terminal reviewer error;
- phase transitions, consolidation dispatch/result, fix dispatch/result;
- snapshot/package identity, stale evidence, and fatal integrity failures; and
- user commands whose acknowledgement promises durable state.

These commits continue to announce immediately when the UI must be able to act
on the new durable state.

### Observational checkpoints — coalesced

The following may be accumulated in memory for the duration of one supervisor
pass and committed together:

- token/usage deltas already recoverable from provider snapshots;
- transcript progress digest and `progressAt`;
- `stalledSince` warning state;
- non-terminal status refreshes that do not authorize a new action; and
- timing/diagnostic counters projected to the workflow.

The checkpoint must flush before a terminal/safety commit, service shutdown,
lease handoff, or response to a read-after-write command.

## Design

Add an explicit commit intent to the fan-out host instead of allowing every
reviewer branch to call the undifferentiated `save()` function. A suggested
shape is:

```text
commitSafety(reason, mutation)
stageObservation(reviewerId, patch)
flushObservations(reason)
```

All mutations are applied through a workflow-local serialized commit queue. It
re-reads or checks the controller fence, applies a patch to the latest canonical
workflow, increments the revision once, persists once, and publishes at most one
event. This prepares the safe merge point required by concurrent Step 05.

Do not retain stale whole-workflow clones in reviewer tasks. Observation patches
must be field-scoped and include the reviewer/session generation they were
derived from; discard a patch when the canonical reviewer no longer matches.

## Storage tasks

- [ ] Add save options in `apps/backend/src/core/storage-reviews.ts` that
  distinguish workflow safety data from high-churn lease/observation data.
- [ ] Use `backup: false` for renewable lease-only writes after proving the
  primary JSON atomic-write behavior remains intact. Lease history is not user
  state and default backup rotation multiplies filesystem operations.
- [ ] Keep backup rotation for material workflow safety commits. Do not disable
  it globally to improve a benchmark.
- [ ] Coalesce observation writes in `multi-review-service.ts` and the Build
  Pipeline fan-out owner.
- [ ] Publish one `multi-review` resource event for one checkpoint. Safety
  commits continue to publish immediately where required.
- [ ] Flush staged patches in `finally` paths without allowing a failed
  observational flush to turn an already-settled provider result into a retry.
- [ ] Keep the lease and protected workflow transition in the same atomic store.
  Do not introduce a separate lease file without a transactional replacement.
- [ ] Bound pending patches by live reviewer count; one newest patch per
  reviewer, never an append-only list.

## Renderer effects

`apps/web/src/lib/store-resource-sync.ts` currently responds to each resource
announcement by refetching. Retain snapshot refetch as the authority, but ensure
coalesced events do not hide safety transitions. If an optional revision is
already current, the store may skip an identical refetch; it must refetch on a
gap, reconnect, or unknown revision.

## Crash and fence scenarios

Tests must cover a crash/fence loss:

- immediately before and after `dispatching` persistence;
- while `sendPrompt` is pending;
- after provider acceptance but before `sent` persistence;
- while observations are staged;
- between observation flush and event publication; and
- during lease renewal and service shutdown.

Expected behavior is unchanged: ambiguous dispatch stays parked, a stale
controller cannot commit, and losing observational metadata may delay a progress
indicator but never duplicates a turn or loses an accepted report.

## Tests and measurements

- Add unit tests for patch merge, generation rejection, flush ordering,
  boundedness, and observer exceptions.
- Extend `storage-multi-review.test.ts` to assert backup policy and atomic
  recovery from primary/backup corruption.
- Extend resource-sync tests to assert one checkpoint event, revision-gap
  refetch, reconnect rehydration, and immediate terminal updates.
- Run the baseline at 1/2/4/8/32 reviewers. Record logical saves, physical file
  operations, backup rotations, announcements, and web refetches.

## Acceptance criteria

- No more than one observational save/event per completed supervision pass,
  independent of how many reviewers changed progress.
- Every dispatch, terminal, cancellation, and phase transition retains its
  immediate durability boundary.
- Lease-only renewals do not rotate workflow backups.
- A lost fence rejects all queued/staged writes from the stale controller.
- Inactive tabs rehydrate all coalesced state from the authoritative workflow.
- The store remains recoverable under the existing corruption tests.

## Implementation record

- The runner distinguishes safety commits (`commit()` — immediate, awaited
  before the next fallible step) from observations (`stageObservation()` —
  progress digest/clock, usage, stall warning). Staged observations are
  flushed once at the end of the pass, and ride along on any safety commit
  before then. A failed observational flush is logged, never turned into a
  retry; a lost fence still propagates.
- All runner writes go through one serialized queue. Both owners also
  serialize saves per in-memory workflow/pipeline object, so concurrent
  reviewers cannot race revision-checked writes.
- Lease-only writes (`claim`/`releaseMultiReviewController`) use
  `backup: false`. The store's existing recovery-backup refresh still keeps a
  current `.bak.1`; content commits keep full rotation.
- Fence checks use a lease index cached by the store file's
  inode/size/mtime/ctime. Every write is an atomic rename, so the index cannot
  answer from a replaced file.
- The lease stays in the same atomic store as the workflow, as the index
  requires.
- One save publishes one announcement, so the observation rule also bounds
  resource events. The renderer still refetches on every announcement (see
  Deferred).
- Tests: `review-fanout-efficiency.test.ts` (one observational write for
  several reviewers, none on a throttled pass, no overlapping saves),
  `storage-multi-review.test.ts` (lease writes do not rotate backups; fence
  checks follow external replacement).
- Deferred: skipping identical renderer refetches by revision. The
  resource-change revision is a global counter, not the workflow revision, so
  it cannot identify an already-current snapshot without a protocol change.
  Server-side coalescing already removes most duplicate events.
