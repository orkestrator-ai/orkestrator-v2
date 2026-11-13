# C1 wake reliability: what needs live evidence

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`. Task 2 run 2026-11-13
against `main` at `17d28238c`; task 1 rechecked the same day: still waiting
on the real-store count.

### Tasks

1. **Find out whether pre-status-wake associations remain, then remove the backfill rule** (report part 0090, its Needs verification): retire the rule once the user's count of such associations in their real stores (moved to the manual-test checklist) shows none are left. Status: blocked (waits on 7568: 4860 task 1 real-store count).
2. **Prove the remote goal hold live** (report part 0270): a worker on another node, between goal iterations, does not wake its coordinator. Status: done (2026-11-13, over a real node link; the run with real agent turns is on the manual-test checklist).

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

**Problem.** Writing the decision table for part 0270 showed the remote path had no goal check, so a worker on another node woke its coordinator between goal iterations (`docs/architecture/goals.md` listed this as not proven). The path now holds while the node's registry says the goal is running. Until 2026-11-13 only fakes had exercised that.

**Context.** `NodeCoordinatorRemote.workerState` reads `goal.running` from the worker's entry in `get_agent_registry`, and `decideDelegation` stays open with `goal-running`. An older node sends no `goal`, which reads as false, so it behaves as before. When the goal stops, the next read closes the delegation; there is no edge to do it sooner.

**Investigation.** Unit tests cover the registry read (`nodes/node-coordinator-remote.test.ts`), the delegation staying open and then closing (`coordinator-remote.test.ts`) and the rule (`coordinator-delegation-decision.test.ts`).

On 2026-11-13 `bun scripts/qa-remote-goal-hold.ts` ran it over a real node link on beelink, 6/6 checks:

- Two backends of this checkout on the mixed-version harness (own data directory, HOME and loopback port each, `agent-test` runtime with no toolchain or credentials). The command node attaches the leaf.
- The leaf's worker environment and native tab were made with the ordinary commands. With the leaf stopped, the tab's session was given a goal in `checking` (iteration 1 of 3) whose check waits for a file; the leaf was started again and its own goal service picked the goal up and ran the check in the worktree.
- The coordinator was the production `CoordinatorService` on a real mail store (`MailWorld`, agents simulated), reading the worker through the production `NodeCoordinatorRemote` over the command node's `invoke_on_node`.
- GH-01: the leaf's registry, read over the link, said `idle` with `goal.running: true`.
- GH-02, GH-03: past the 15 s start-up grace, four reads 3 s apart all saw `idle/checking`; the delegation stayed `running` and the coordinator got no wake and no notice.
- GH-04, GH-05: once the file existed the check passed on the leaf (`complete`, `check-passed`), and the next read closed the delegation `completed` with one `notice` wake naming the node. Nothing else changed between the held reads and this one, so the goal was what held it.

No agent turn ran, so this does not show the registry value between two real turns; that run needs a real login and billed turns, and is on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md).

**Decisions.**

- **How to prove it?**
  - **A two-node `dev:test` run with a real goal on the leaf (recommended), recording the coordinator's wakes across at least two iterations.**
    - Pros: the only evidence that the registry value is set between iterations on a real node.
    - Cons: needs two profiles and live agent turns.
  - **Add it to the opt-in goal suite (`coordinator-live-goal`).**
    - Pros: repeatable.
    - Cons: that suite has no second node today, so this is more harness work than the check.

## Assumptions and decisions

### Task 2: a held check instead of agent turns (2026-11-13)

The recommended run used live agent turns, which this host must not make
(no real logins, no billed turns). A goal in `checking` is the same state
the coordinator sees between iterations (the tab idle, `goal.running`
true), and the leaf's own goal service runs it with no agent. The goal was
written into the stopped leaf's store because setting one through `/goal`
sends its first turn at once, which with no agent pauses the goal within
seconds. The two-turn run with a real agent is a checklist item.

### Task 2: the coordinator in the harness, not on the command node

The command node is a real backend and carries every read, but the
coordinator that decides is the production service on the harness's own
mail store. Seeding a delegation into the command node's coordinator
store would mean faking a coordinator conversation whose agent cannot
start there, for no extra code under test: the reads and the decision are
the same classes. The node's mail collection answers "collected, nothing
held", since the worker sends no report.

### Task 2: a script, not a mixed-version module

The runner's modules run against already started nodes, and this check has
to write the goal before the leaf starts. It is a separate script on the
same harness (`scripts/qa-remote-goal-hold.ts`), so it does not restart a
node under the other modules.

## Related

- [`scripts/qa-remote-goal-hold.ts`](../../../scripts/qa-remote-goal-hold.ts): the two-node goal hold run (task 2).

- C1 outcome record (`git show 413bd6219:docs/reports/2026-11-04-coordinator-c1-wake-reliability-outcome.md`): every task in the report and where it went
- to-do 2900 (retired 2026-11-10; see [coordinator.md](../../architecture/coordinator.md#coordinators-on-two-nodes)): the same two-node setup
- [`docs/architecture/coordinator.md`](../../architecture/coordinator.md#status-wakes)
- [`docs/architecture/goals.md`](../../architecture/goals.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: counting old associations in the real coordinator stores) moved there on 2026-11-10, and the real-agent run of task 2 on 2026-11-13.

## Replaces

The Needs verification of part 0090, and the differences part 0270 asked to settle, in coordinator report C1 (Wake reliability). Its file was deleted when it was built; it is in the history at `e198fd4a7`.
