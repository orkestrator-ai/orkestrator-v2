# C1 wake reliability: what needs live evidence

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`.

### Tasks

1. **Find out whether pre-status-wake associations remain, then remove the backfill rule** (report part 0090, its Needs verification): retire the rule once the user's count of such associations in their real stores (moved to the manual-test checklist) shows none are left. Status: blocked (waits on 7568: 4860 task 1 real-store count).
2. **Prove the remote goal hold live** (report part 0270): a worker on another node, between goal iterations, does not wake its coordinator. Status: open.

### 1. Find out whether pre-status-wake associations remain, then remove the backfill rule

**Problem.** Part 0090 limited the 24-hour backfill rule to associations over 14 days old, so a notice held while no main was open now reaches the main opened since. A project idle for longer than that still loses the notice, because the rule still swallows it. The rule exists only for workflows older than status wakes, and whether any are still in a real store decides how much it does.

**Context.** Status wakes shipped on 2026-10-16 (`bcce21c11`, #1031). The rule is `isStatusBackfill` in `apps/backend/src/core/coordinator-status-backfill.ts`, called from `observeAssociation` in `coordinator-status-wakes.ts`. It applies to a non-terminal status with no earlier notice, unchanged for over 24 hours, on an association over `STATUS_BACKFILL_ASSOCIATION_AGE_MS` (14 days) old. Retention removes old finished records (`coordinator-workflow-retention.ts`), so few should remain. 14 days was chosen because it is under the 19 days between the feature and this work, so every pre-feature association counted as old when the limit shipped.

**Investigation.** Not read: the build worker runs beside the user's production instance and must not touch its data directory. Nothing in the repository says what a real store holds. The query is simple: on each machine, the coordinator store's `workflows` of kind `multi-review`, `build-pipeline`, `graph-run`, `pull-request` or `feature-plan` with `createdAt` before 2026-10-16, no `statusNotice` and no `terminalNotifiedAt`. Running it on the user's machines is on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md); when it reports none, delete the rule and its module.

**Decisions.**

- **What to do with the rule?**
  - **Check the user's machines, and delete the rule and its module once none remain (recommended).**
    - Pros: the last way to lose a held notice goes away; less code.
    - Cons: needs the user, or an agent they authorize, to read real stores.
  - **Delete it after a fixed time without checking.**
    - Pros: no store reads.
    - Cons: an old record then wakes a coordinator once about old news, which is the surprise the rule exists to stop.
  - **Keep it as it is.**
    - Pros: no work.
    - Cons: a project idle for over 14 days keeps losing its held notice.

### 2. Prove the remote goal hold live

**Problem.** Writing the decision table for part 0270 showed the remote path had no goal check, so a worker on another node woke its coordinator between goal iterations (`docs/architecture/goals.md` listed this as not proven). The path now holds while the node's registry says the goal is running. Only fakes have exercised that.

**Context.** `NodeCoordinatorRemote.workerState` reads `goal.running` from the worker's entry in `get_agent_registry`, and `decideDelegation` stays open with `goal-running`. An older node sends no `goal`, which reads as false, so it behaves as before. When the goal stops, the next read closes the delegation; there is no edge to do it sooner.

**Investigation.** Unit tests cover the registry read (`nodes/node-coordinator-remote.test.ts`), the delegation staying open and then closing (`coordinator-remote.test.ts`) and the rule (`coordinator-delegation-decision.test.ts`). No two-node run has exercised it.

**Decisions.**

- **How to prove it?**
  - **A two-node `dev:test` run with a real goal on the leaf (recommended), recording the coordinator's wakes across at least two iterations.**
    - Pros: the only evidence that the registry value is set between iterations on a real node.
    - Cons: needs two profiles and live agent turns.
  - **Add it to the opt-in goal suite (`coordinator-live-goal`).**
    - Pros: repeatable.
    - Cons: that suite has no second node today, so this is more harness work than the check.

## Related

- C1 outcome record (`git show 413bd6219:docs/reports/2026-11-04-coordinator-c1-wake-reliability-outcome.md`): every task in the report and where it went
- to-do 2900 (retired 2026-11-10; see [coordinator.md](../../architecture/coordinator.md#coordinators-on-two-nodes)): the same two-node setup
- [`docs/architecture/coordinator.md`](../../architecture/coordinator.md#status-wakes)
- [`docs/architecture/goals.md`](../../architecture/goals.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: counting old associations in the real coordinator stores) moved there on 2026-11-10.

## Replaces

The Needs verification of part 0090, and the differences part 0270 asked to settle, in coordinator report C1 (Wake reliability). Its file was deleted when it was built; it is in the history at `e198fd4a7`.
