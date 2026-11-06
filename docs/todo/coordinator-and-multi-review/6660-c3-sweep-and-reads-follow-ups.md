# Coordinator sweep and reads: what C3 left

## Task analysis

Analysed 2026-11-05 against `main` at `cd7e963ec`, with coordinator batch C3 (Sweep and reads) applied.

### Tasks

1. **Prune finished workflow records below the limit**: decide on a measurement from a real large store. Status: open.
2. **A sweep's wake pass repeats the main's repair per wake**: measure, then decide whether a wake for an open, assigned main needs it. Status: open.

### 1. Prune finished workflow records below the limit

**Problem.** Finished workflow records stay in the coordinator store until it reaches 2,000 records, and the sweep, every coordinator read and the panel's view walk all of them. C3 measured that cost and found it small, but only on a synthetic store.

**Context.** From coordinator report C3, part `0110`, task 4. `makeRoomForWorkflowAssociation` (`storage-coordinators.ts`) clears a batch of the oldest finished records only when a new record would go past `MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS`. The selection lives in `coordinator-workflow-retention.ts` and is tested. `docs/architecture/coordinator.md` (Workflow record limit and cleanup) says history stays until the room is needed, so `list_workflows` and the Work panel keep it.

**Investigation.** `apps/backend/scripts/coordinator-sweep-bench.ts` on an isolated synthetic store, after C3, mean milliseconds per call on one host:

| Store | Sweep | Read (`get`) | View |
| --- | --- | --- | --- |
| 40 coordinators, 400 open, 1,400 finished (1,800 records) | 53, 56 | 5.2, 5.6 | 5.4, 6.0 |
| 40 coordinators, 400 open, none finished (400 records) | 48, 48 | 3.3, 3.5 | 3.4, 3.5 |

So 1,400 finished records cost 5 to 8 ms on a sweep that runs every 60 s and about 2 ms on a read. Before C3 the same stores took 797 to 846 ms and 398 to 400 ms per sweep, and 15.5 to 16.1 ms and 9.5 to 9.7 ms per read or view. No real store with many coordinators and records was available: the build could not use the production data directory.

**Decisions.**

- **Prune on a schedule?**
  - **Leave retention as it is unless a real store shows the walk matters (recommended).** Run the bench's measurement against a copy of a real large data directory (or an isolated `dev:test` profile seeded to the same size), and prune from the sweep with the existing selection only if the read or view cost is noticeable.
    - Pros: no behaviour change without evidence; the history the docs promise stays.
    - Cons: the walk stays, at about 2 ms per read on the synthetic store.
  - **Run the cleanup selection from the sweep now.**
    - Pros: lists stay short however long a machine runs.
    - Cons: `list_workflows` and the Work panel lose finished rows earlier than documented, for a cost the measurement calls small.

### 2. A sweep's wake pass repeats the main's repair per wake

**Problem.** Each delegation wake calls `ensureMainConversation`, which runs the full repair for that main: adoption of every other conversation's live work, a mailbox sync for the whole backend, an owed-set read and a mail move. A sweep that delivers several wakes therefore syncs mailboxes once per wake, on top of the sweep's own sync.

**Context.** Found while building C3, part `0110`, task 1, which moved the sweep's own sync and scans to once per pass. The wake path was out of that task's scope. `deliverDelegationWake` in `coordinator-service.ts` relies on `ensureMainConversation` both to open a main when the last one closed and to move a closed main's held report before choosing the wake kind.

**Investigation.** Read from the code only. The C3 bench owes no wakes, so it does not measure this. When the main is open and already has an agent, the repair finds nothing to do unless a conversation closed since the last sweep; it still costs the sync, two coordinator store reads and a pass over the mail store per wake.

**Decisions.**

- **What to change?**
  - **Measure a pass with many owed wakes first, then skip the repair when the main was already open with an agent and no conversation closed since the last repair (recommended).**
    - Pros: keeps the repair where a main is new or a close happened, which is what moves held reports; removes per-wake syncs in the common case.
    - Cons: needs a reliable "nothing closed since" signal, such as the workspace's `updatedAt` or the store revision.
  - **Leave it.**
    - Pros: no change to a path whose ordering the wake's crash safety depends on.
    - Cons: a burst of wakes repeats a backend-wide sync per wake.

## Current state

C3 made the sweep's mailbox sync and owed-delegation reads run once per pass, made coordinator reads write nothing, and cut a delegation wake to two coordinator writes and one announcement. Its outcome table is in the last version of the deleted report: `git show abc3eea16^:docs/reports/coordinator/0110-c3-sweep-and-reads.md`.

## Needs verification

- Both tasks rest on a synthetic store. Neither has been measured on a real store with many coordinators and records.

## Related

- [Coordinator batches outcome](../../reports/2026-11-06-coordinator-batches-outcome.md#status-of-every-finding), finding B1 ("list walked long before the cap")
- [6360-c2-workflow-records-live-checks.md](6360-c2-workflow-records-live-checks.md): the store-full banner on a live stack, which needs the same kind of seeded store

## Assumptions and decisions

### Task 2: retained closed mains and wake selection

The review fix checks closed mains for this worker's held report before deferring
notice selection. Empty historical inboxes allow two coordinator writes after a
successful replacement; a held report still waits for repair. Keeping the blanket
history guard would preserve three writes even when repair has finished. This does
not remove the per-wake repair or replace task 2's measurement.

The recovery command uses the final deletion's parent so it includes the corrected
main-opening path list, rather than finding the earlier deletion by its subject.

### Tasks 1 and 2: report recovery from merged history

Use the parent of the merged C3 deletion commit `abc3eea16` for the recovery
command. This keeps the full report available from main's history instead of
depending on the unmerged commit `b0fbe4ee1`. A link to the batch record would
identify the closure but would not retrieve the original report.
