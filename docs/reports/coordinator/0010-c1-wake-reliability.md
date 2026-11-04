# C1: Wake reliability

This file combines 6 reports into one batch to build together. Same delegation close and wake paths. Do the `0270` refactor last.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0010](#0010-one-failing-delegation-stops-wakes-for-every-project) | High | Per-item error handling in the delegation wake and reconcile loops, and retiring a delegation that keeps failing. |
| [0050](#0050-a-delegation-closing-during-a-wake-pass-waits-for-the-next-sweep) | High | A rerun flag so a delegation closing mid-pass is not left for the next sweep. |
| [0090](#0090-status-notices-held-while-no-main-is-open-are-dropped-after-24-hours) | Medium | Limiting the 24-hour backfill rule so held status notices are not dropped. |
| [0290](#0290-close-select-and-pause-are-outside-the-per-project-serializer) | Low | Serializing close, select and pause, with a check before marking a wake done. |
| [0300](#0300-a-waiting-episode-is-cleared-only-on-a-working-edge) | Low | Clearing the waiting marker on any edge that leaves waiting. |
| [0270](#0270-is-this-delegation-finished-is-decided-in-three-places) | Medium | One pure function for deciding whether a delegation is finished. |

## 0010: One failing delegation stops wakes for every project

### Task analysis

#### Tasks

1. **Isolate failures per item**: the wake pass and the reconcile sweep catch and log errors per delegation, so one failure cannot stop the rest. Status: open.
2. **Retire a delegation that keeps failing**: after K failed wake attempts, mark it failed and send one system notice. Status: open (depends on 1).

#### 1. Isolate failures per item

**Problem.** `deliverDelegationWakesOnce` walks every unwoken delegation of every project with no per-item catch. A throw ends the pass, the same delegation comes first again on the next sweep, and every wake behind it waits indefinitely.

**Context.** The status-wake pass already isolates its items (`coordinator-status-wakes.ts:1106-1110` and `:1123-1125`). `coordinator-repair` runs every 60 s and logs a throttled `job.failed` for the whole job (`apps/backend/src/core/index.ts:2351-2365`).

**Investigation.** `coordinator-service.ts:1181-1349` has no try/catch around the loop body. The notice path catches only `idempotency-conflict` (`:1339-1345`), so `messaging-disabled` from `storage-agent-mail.ts:470` propagates. `ensureMainConversation` (`:1198`) can throw "Coordinator conversation limit reached" (`:291`). `reconcileWorkerDelegations` has the same shape in three places: the per-workspace `reconcileMainMail` loop (`:1012-1015`), the per-delegation loop (`:1016-1071`) and the final wake call (`:1072`), so a throw early on also skips `releaseOrphanedDelegationHolds` (`:1079`). `settleWorkerDelegations` (`:918`) and `settleRemoteWorker` (`:1091`) share the same pass.

**Decisions.**

- **Where should the catch sit?**
  - **Around each item in each loop, logging the association id (recommended).**
    - Pros: matches the status wakes; a bad item costs only itself; the later steps of the sweep still run.
    - Cons: a permanently failing item logs on every sweep until task 2 lands, so the log needs throttling.
  - **Only around the outer job.**
    - Pros: no change to the loops.
    - Cons: that is what exists today; the first failure still hides everything after it.

#### 2. Retire a delegation that keeps failing

**Problem.** Isolation alone leaves a delegation that can never deliver retried for ever, with the coordinator never told.

**Context.** The report suggests marking it `failed` after K failures with one notice. A notice itself goes through `sendAgentMail`, so it can fail for the same reason.

**Investigation.** `CoordinatorDelegation` (`packages/protocol/src/coordinator.ts:264-296`) has no attempt counter. `wokenAt` is the only receipt, and "unwoken" is what retention protects (`docs/architecture/coordinator.md:65-68`), so a stuck record also holds a slot in the shared store.

**Decisions.**

- **How to count attempts?**
  - **In memory per association, with a persisted terminal mark once K is reached (recommended).**
    - Pros: no write on each failed sweep; a restart only restarts the count.
    - Cons: a backend that restarts more often than K sweeps never retires the item.
  - **A persisted attempt counter on the delegation.**
    - Pros: survives restarts.
    - Cons: one store write per failing delegation per minute, on a store that is rewritten whole.
- **What if messaging is off?**
  - **Hold, do not retire (recommended).** `messaging-disabled` is a setting, not a fault of this delegation.
    - Pros: turning messaging back on delivers the wakes.
    - Cons: needs an error-code check in the retire path.
  - **Treat it like any other failure.**
    - Pros: one code path.
    - Cons: a user who pauses messaging for a day loses every wake owed.

### Needs verification

Each throw source above was read in code; none was reproduced, since nothing was run for this analysis.

## 0050: A delegation closing during a wake pass waits for the next sweep

### Task analysis

#### Tasks

1. **Run one more pass when asked mid-pass**: a call made while a pass runs schedules one further pass after it. Status: open.

#### 1. Run one more pass when asked mid-pass

**Problem.** A worker that finishes while another worker's wake is being delivered can wait up to a minute to report.

**Context.** A pass can take seconds: `ensureMainConversation` does a full mailbox sync (`coordinator-service.ts:1198`, `:325`) and the notice path reads a transcript excerpt (`:1265-1278`). The fallback is `coordinator-repair`, every 60 s (`docs/architecture/recurring-work.md`, B11).

**Investigation.** `deliverDelegationWakes` (`coordinator-service.ts:1172-1179`) returns the promise of the running pass. That pass read its list once at `:1182`, before the new delegation closed. Parallel workers are the normal case for a coordinator, so this is reachable without a fault.

**Decisions.**

- **How to rerun?**
  - **A `rerunRequested` flag that loops the pass until it is clear (recommended).**
    - Pros: coalesces any number of calls into one extra pass; callers keep awaiting one promise.
    - Cons: the awaited promise can last longer; a caller holding `withAgentMailWorkerAdmission` must not await it (today's callers await after the lock at `:879-918`).
  - **Re-read the list inside the loop after each item.**
    - Pros: no flag.
    - Cons: one store read per delivered wake, and it makes the loop's termination depend on new closes.

## 0090: Status notices held while no main is open are dropped after 24 hours

### Task analysis

#### Tasks

1. **Limit the backfill rule to old associations**: stop it swallowing notices for work that began after status wakes existed. Status: open.

#### 1. Limit the backfill rule to old associations

**Problem.** A review reaches `ready` on Friday with the main closed. The user starts a main on Monday, and the coordinator never hears about it, although the doc promises it will.

**Context.** The rule exists so that workflows older than status wakes do not all wake at once. The doc says that with no main open notices wait and "the sweep sends the state current when one opens" (`docs/architecture/coordinator.md:1707-1709`).

**Investigation.** `coordinator-status-wakes.ts:1232-1241` records any non-terminal status with no prior notice and an `updatedAt` older than `STATUS_BACKFILL_LIMIT_MS` (24 h, `:112`) as noticed, without sending. `deliver` returns false with no main (`:1940-1941`), so the notice is retried until the 24 h passes and then discarded. Terminal states are not affected (`!status.terminal`).

**Decisions.**

- **What marks an association as predating status wakes?**
  - **Skip the rule for any association created in the last N days, or drop it once records that old have aged out (recommended).** Retention now removes old finished records, so few pre-feature records remain.
    - Pros: no new stored field; the rule retires itself.
    - Cons: N is a judgement, and a project idle for longer than N still loses the notice.
  - **Store a cutover timestamp at first boot of a new version, as the report proposes.**
    - Pros: exact: only records older than the cutover are skipped.
    - Cons: a new persisted value whose only purpose ends once those records are gone.

### Needs verification

Whether any association from before status wakes is still in a real store, which decides how much the rule still does.

## 0290: Close, select and pause are outside the per-project serializer

### Task analysis

#### Tasks

1. **Serialize them**: `closeConversation`, `selectConversation` and `setPaused` run in `serialize` like create and ensure. Status: open.

#### 1. Serialize them

**Problem.** A close can land between `ensureMainConversation` returning and the wake being sent, so the report goes to a tombstoned mailbox and the delegation is marked woken.

**Context.** `serialize` covers create, ensure and assign (`coordinator-service.ts:430`, `:461`, `:578`, `:655`). It does not cover the wake pass: `deliverDelegationWakesOnce` holds only the ensure step (`:1198`), then uses the returned conversation for the release or send (`:1219`, `:1288`).

**Investigation.** `closeConversation` (`:739-765`), `selectConversation` (`:713-737`) and `setPaused` (`:767-797`) call `mutateCoordinatorWorkspace` directly. Each store mutation is safe by itself (`enqueueCoordinatorMutation`), so the risk is the gap between steps, not a torn write. So serializing close does not by itself close the gap, unless the wake's send also runs inside `serialize`.

**Decisions.**

- **Is wrapping the three enough?**
  - **Wrap them, and re-check the conversation is open just before `markCoordinatorDelegationWoken`, leaving it unwoken if it closed (recommended).**
    - Pros: the delegation is retried and adopted by the next main, with no lock held across a mail send.
    - Cons: the mail already sent to the closed box needs `moveClosedCoordinatorMail` to carry it, which it does for owed reports.
  - **Run each wake's send inside `serialize` as well.**
    - Pros: closes the gap outright.
    - Cons: a slow send blocks the user's close and select on that project.

### Needs verification

Reported in the report and confirmed by reading only; the race was not reproduced.

## 0300: A waiting episode is cleared only on a working edge

### Task analysis

#### Tasks

1. **Clear `waiting` on any edge that leaves waiting**: including waiting to idle on a delegation that stays open. Status: open.

#### 1. Clear `waiting` on any edge that leaves waiting

**Problem.** After waiting → idle on an open delegation, the "needs you" marker stays, and a later wait produces no new notice.

**Context.** A delegation stays open past an idle edge while a follow-up is undelivered or background work holds it. The field's doc comment says it is cleared "when the worker is seen working again" (`packages/protocol/src/coordinator.ts:283-290`), so the comment needs changing too. The Work panel now reads the marker for its Needs you section (`docs/architecture/coordinator.md:1021`), so a stale marker is more visible than when the report was written.

**Investigation.** `noteWorkerActivity` clears only on `event.state === "working"` (`coordinator-status-wakes.ts:1739-1751`). `reconcileWaiting` clears only on `activity === "working"` (`:1805-1818`). A repeat wait then returns early at `:1727`, and `notifiedAt` stops a second notice at `:1833`.

**Decisions.**

- **What counts as leaving?**
  - **`idle`, `working` or `stopped`, but not `unknown` (recommended).**
    - Pros: an unreadable state cannot end an episode and re-notify.
    - Cons: a quick waiting → idle → waiting flap is a new episode, which the 20 s debounce absorbs.
  - **Any state other than `waiting`.**
    - Pros: simpler.
    - Cons: a read failure on a remote node (`unknown`, `:1800-1803`) would clear it and re-notify.

## 0270: "Is this delegation finished?" is decided in three places

### Task analysis

#### Tasks

1. **Extract one pure decision function**: `decideDelegation(state, observations)` with a table of transitions. Status: open.

#### 1. Extract one pure decision function

**Problem.** Three paths check undelivered requests, grace, background work, goals and stopped state, each in its own order. A rule added to one can be missed in the others.

**Context.** The state is spread over persisted delegation fields and three in-memory maps (`remoteSeenWorking`, `remoteAskedAt`, `backgroundWorkSince`, `coordinator-service.ts:180-187`).

**Investigation.** The paths differ today. `settleWorkerDelegations` (`:874-919`) has no goal check, while `reconcileWorkerDelegations` does (`:1060`), and `stop_worker_turn` handling lives in `backgroundWorkDisposition` (`:932-976`). `reconcileRemoteDelegation` (`:1099-1161`) has its own seen-working rule. Each of these differences may be deliberate, and nothing records which.

**Decisions.**

- **How far to go?**
  - **A pure function that takes gathered observations, with reads left in the callers, plus a table test (recommended).**
    - Pros: documents the state machine; each rule tested without storage.
    - Cons: writing the table will force a decision on each difference above, and some may be bugs.
  - **Comments only.**
    - Pros: no risk to a crash-safe path.
    - Cons: the drift continues.

### Constraints and rationale

- Close and wake ordering must stay as the report's section 3 describes. This refactor covers only the decision to close.

## Related

- [Coordinator report, 4.2 (B2)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability)
- [C5 part 0030](0030-c5-prompt-and-context.md#0030-with-agent-messaging-off-the-coordinator-is-still-told-to-delegate): how a coordinator comes to rely on wakes with messaging off
- [Coordinator report, 4.2 (B3)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability)
- [C1 part 0010](#0010-one-failing-delegation-stops-wakes-for-every-project): touches the same pass
- [Coordinator report, 4.2 (B5)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability)
- [Coordinator report, 4.2 (B6)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability) and [6, partial serialization](../2026-10-27-coordinator.md#6-maintainability)
- [C1 part 0300](#0300-a-waiting-episode-is-cleared-only-on-a-working-edge): the other half of B6
- [Coordinator report, 4.2 (B6)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability)
- [Coordinator report, 6](../2026-10-27-coordinator.md#6-maintainability)
