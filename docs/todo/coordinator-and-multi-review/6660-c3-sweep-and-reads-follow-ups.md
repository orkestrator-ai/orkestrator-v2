# Coordinator sweep and reads: what C3 left

## Task analysis

Analysed 2026-11-05 against `main` at `cd7e963ec`, with coordinator batch C3 (Sweep and reads) applied. Task 2 analysed and closed 2026-11-13 against `main` at `17d28238c`.

### Tasks

1. **Prune finished workflow records below the limit**: decide on a measurement at a real large store's size. Counting a real store's coordinators and records on the user's machines moved to the manual-test checklist; then run the bench at those figures and decide. Status: blocked (waits on 7568: 6660 task 1 real-store count).
2. **A sweep's wake pass repeats the main's repair per wake**: measured 2026-11-13 (about 2 to 9 ms per wake) and kept as it is. Status: done.

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
  - **Leave retention as it is unless a real store shows the walk matters (recommended).** Run the bench's measurement against a copy of a real large data directory (or an isolated `dev:test` profile seeded to the same size), and prune from the sweep with the existing selection only if the read or view cost is noticeable. The bench builds only a synthetic store (its `--projects`, `--open` and `--finished` options), so the user's count of a real store (on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)) sets those figures.
    - Pros: no behaviour change without evidence; the history the docs promise stays.
    - Cons: the walk stays, at about 2 ms per read on the synthetic store.
  - **Run the cleanup selection from the sweep now.**
    - Pros: lists stay short however long a machine runs.
    - Cons: `list_workflows` and the Work panel lose finished rows earlier than documented, for a cost the measurement calls small.

### 2. A sweep's wake pass repeats the main's repair per wake

**Problem.** Each delegation wake calls `ensureMainConversation`, which runs the full repair for that main: adoption of every other conversation's live work, a mailbox sync for the whole backend, an owed-set read and a mail move. A sweep that delivers several wakes therefore syncs mailboxes once per wake, on top of the sweep's own sync.

**Context.** Found while building C3, part `0110`, task 1, which moved the sweep's own sync and scans to once per pass. `deliverDelegationWake` in `coordinator-service.ts` relies on `ensureMainConversation` both to open a main when the last one closed and to move a closed main's held report before choosing the wake kind.

**Investigation.** `coordinator-sweep-bench.ts --owed N` (added for this task) makes N delegations finish without a wake before each measured sweep, on mains that are open with an agent, and alternates two variants so both see the same store growth: the sweep as it runs, and the same sweep with each wake's `ensureMainConversation` cut to its open-main lookup (what skipping the repair would leave). It also times the real `ensureMainConversation` and counts `synchronizeAgentMailboxes` calls. Mean per pass, one Linux host shared with other builds (load average 5 to 8, so the absolute figures are noisy; compare within a row):

| Store and wakes | Pass with repair | Pass without | Repair per wake | Syncs per pass | One sync |
| --- | --- | --- | --- | --- | --- |
| 40 projects, 400 open, 40 wakes (one per project), run 1 | 728 ms | 527 ms | 6.7 ms | 41 | 4.7 ms |
| same, run 2 | 940 ms | 713 ms | 8.6 ms | 41 | 6.1 ms |
| 4 projects, 40 open, 20 wakes (five per project) | 125 ms | 94 ms | 2.2 ms | 21 | 1.4 ms |
| 40 projects, 400 open, 2 wakes | 42 ms | 35 ms | 4.0 ms | 3 | 3.0 ms |
| 40 projects, 400 open, 1 wake | 31 ms | 29 ms | 3.9 ms | 2 | 2.7 ms |

The same sweep with no wake owed took 21 to 23 ms. So the repair is about a quarter of a wake's cost, most of it the backend-wide mailbox sync, whose cost grows with the number of mailboxes; a pass with one or two wakes pays 2 to 8 ms more on a 60 s cadence, and a burst of 40 wakes about 200 ms once. Commands (from the repository root): `mise exec -- bun apps/backend/scripts/coordinator-sweep-bench.ts --projects 40 --open 10 --finished 0 --iterations 10 --owed 40`, then `--projects 4 ... --owed 20`, `--iterations 20 --owed 2` and `--owed 1`. `apps/backend/tests/coordinator-sweep-bench.test.ts` keeps the mode working and pins one sync per wake plus the sweep's own.

Reading the code again for the decision corrected the premise above: the wake path calls `ensureMainConversation` without `opened`, so `reconcileMainMail` runs with `closedOnly` false and also moves **open** side conversations' live work onto the main. The repair is therefore not idle when no conversation closed: work a side conversation launched since the last repair moves on the next wake. Neither the workspace's `updatedAt` nor the coordinator store's revision says whether that happened (every wake writes the store twice).

**Decisions.**

- **What to change?**
  - **Skip the repair when the main was already open with an agent and no conversation closed since the last repair.**
    - Pros: removes the per-wake sync in the common case, about a quarter of a wake.
    - Cons: not behaviour-neutral: a side conversation's new live work would stay with it until a later wake or the user's next action, and the "nothing closed since" signal does not cover that. It saves 2 to 8 ms per sweep with one or two wakes.
  - **Bound it to one repair per project per wake pass.**
    - Pros: keeps a repair in every pass that wakes a project.
    - Cons: saves only on several wakes for one project in one pass (about 1.5 ms per extra wake in the five-per-project row), and has the same ordering question for work started between two wakes.
  - **Leave it (recommended, chosen).**
    - Pros: no change to a path whose ordering the wake's crash safety and the held-report move depend on; the measured cost is a few milliseconds per wake.
    - Cons: a burst of wakes still repeats a backend-wide sync per wake (about 200 ms for 40 wakes).

## Current state

C3 made the sweep's mailbox sync and owed-delegation reads run once per pass, made coordinator reads write nothing, and cut a delegation wake to two coordinator writes and one announcement. Its measurement, task-by-task outcome table and main-opening paths are preserved in C3: archived outcome (`git show 413bd6219:docs/reports/2026-11-06-coordinator-batches-outcome.md`).

## Needs verification

- Task 1 rests on a synthetic store and has not been measured at a real store's size; it waits on the user's count.

## Related

- Coordinator batches outcome (`git show 413bd6219:docs/reports/2026-11-06-coordinator-batches-outcome.md`), finding B1 ("list walked long before the cap")
- 6360 (retired 2026-11-13): the store banner on a live stack, now checked with `dev:test --seed-workflow-records` ([agent-testing.md](../../development/agent-testing.md#seeded-coordinator-workflow-records---seed-workflow-records))
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: counting a real coordinator store's records) moved there on 2026-11-10.

## Assumptions and decisions

### Task 2: retained closed mains and wake selection

The review fix checks closed mains for this worker's held report before deferring
notice selection. Empty historical inboxes allow two coordinator writes after a
successful replacement; a held report still waits for repair. Keeping the blanket
history guard would preserve three writes even when repair has finished. This does
not remove the per-wake repair or replace task 2's measurement.

### Tasks 1 and 2: preserve the detailed C3 outcome

Copy the branch report's outcome, including the measurement, task table and
corrected main-opening path list, into the coordinator outcome report and link
there. The parent of the squash merge `abc3eea16` contains only the pre-build
report. Restoring `b0fbe4ee1^` would retrieve the outcome locally but would still
depend on unmerged branch history; linking only to the batch record would omit
the detail. The archived copy keeps that detail available with the living docs
and supersedes the earlier merged-history recovery decision.

### Task 2: keep the per-wake repair

Measured with the bench's new `--owed` mode (Investigation above) and kept,
the file's "Leave it" option. The earlier recommendation assumed the repair
does nothing unless a conversation closed; the code shows a wake also moves
open side conversations' live work onto the main, so skipping it changes
behaviour, for a saving of a few milliseconds per wake. Nothing about this
needs the user: it is a no-change outcome within the file's own options.
