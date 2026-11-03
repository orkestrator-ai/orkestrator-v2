# One failing delegation stops wakes for every project

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Isolate failures per item**: the wake pass and the reconcile sweep catch and log errors per delegation, so one failure cannot stop the rest. Status: open.
2. **Retire a delegation that keeps failing**: after K failed wake attempts, mark it failed and send one system notice. Status: open (depends on 1).

### 1. Isolate failures per item

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

### 2. Retire a delegation that keeps failing

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

## Needs verification

Each throw source above was read in code; none was reproduced, since nothing was run for this analysis.

## Related

- [Coordinator report, 4.2 (B2)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability)
- [0030-delegation-offered-with-messaging-off.md](0030-delegation-offered-with-messaging-off.md): how a coordinator comes to rely on wakes with messaging off
