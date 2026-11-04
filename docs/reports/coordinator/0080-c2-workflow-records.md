# C2: Workflow records

This file combines 3 reports into one batch to build together. Same workflow store, and `0100` links to `0080`.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0080](#0080-a-full-workflow-store-is-invisible-to-the-user) | Medium | The swallowed delegation-open error, showing store-full to the user, and settling the shared cap. |
| [0100](#0100-delegations-to-a-forgotten-node-never-close) | Medium | Closing work when a node is forgotten, and a notice for a long-offline node. |
| [0380](#0380-duplicated-request-alias-lookup) | Low | One shared alias lookup.: Duplicated request-alias lookup |

## 0080: A full workflow store is invisible to the user

### Task analysis

#### Tasks

1. **Stop swallowing a failed delegation open**: `send_message` tells the coordinator when its message opened no delegation because of an error. Status: open.
2. **Show store-full to the user**: the panel says the store is full and what frees room. Status: open.
3. **Settle the shared cap**: decide whether one project may still use up the limit for all. Status: open.

#### 1. Stop swallowing a failed delegation open

**Problem.** When the store refuses a new record, a coordinator's message is still sent, no delegation opens, and it is never woken. Nothing tells it why.

**Context.** Retention (see [Current state](#current-state)) makes this rare but does not remove it: a store of 2,000 in-use records still refuses.

**Investigation.** `coordinator-worker-mail.ts:176-181` catches every error from `openWorkerDelegation` and only logs `delegation.open-failed`. The tool result then omits `asyncDelegationResult()` (`control-mcp-tools.ts:2217`), so silence is the only signal; `coordinatorDelegationOpened` itself is stripped from the result (`:2204`).

**Decisions.**

- **What does the model see?**
  - **A `warning` on the result saying no wake will come, and why (recommended).**
    - Pros: the message is already sent, so a refusal would be wrong; the field exists for the project-home warning (`:2212`).
    - Cons: the wording must not read as a failed send.
  - **Fail the call.**
    - Pros: cannot be missed.
    - Cons: the mail is durable and delivered, so a retry reuses the request id with a surprising result.

#### 2. Show store-full to the user

**Problem.** A refused launch reaches only the model; the log line reaches only the operator.

**Context.** `COORDINATOR_WORKFLOW_STORE_IN_USE_ERROR` (`coordinator-workflow-retention.ts:23-27`) already tells the reader what to do.

**Investigation.** `storage-coordinators.ts:161-167` logs and throws. The snapshot has no capacity field (`coordinator-service.ts:518-526`), and the panel has no such banner.

**Decisions.**

- **How does the panel learn?**
  - **Add a bounded state to the snapshot (`workflowStore: "ok" | "near-limit" | "full"`) and render a `CoordinatorBanner` (recommended).**
    - Pros: visible before the first refusal; no extra read.
    - Cons: "near limit" needs a threshold, and only cleanup can establish whether records are clearable.
  - **Rely on the coordinator relaying the error.**
    - Pros: nothing to build.
    - Cons: task 1 shows that it may never see one.

#### 3. Settle the shared cap

**Problem.** The report recommends a per-project cap; the code states the opposite on purpose. One project with many live or remote records can still block every other.

**Context.** `coordinator-workflow-retention.ts:4-7` says "shared on purpose", and `docs/architecture/coordinator.md:94-96` repeats it. Neither records why a per-project limit was rejected.

**Investigation.** Records of remote launches and legacy aliases never become clearable (`coordinator-workflow-retention.ts:110`, `storage-coordinators.ts:182`), so they can build up without limit. [0100](#0100-delegations-to-a-forgotten-node-never-close) adds to that.

**Decisions.**

- **Per project, or shared?**
  - **Keep it shared, and record the reason in the code comment (recommended).**
    - Pros: the store is one file rewritten whole, so its total is what costs; a per-project limit does not bound that.
    - Cons: the noisy-neighbour case stays, softened by tasks 1 and 2.
  - **Add a per-project limit as well as the total.**
    - Pros: isolates a noisy project, which is the report's point.
    - Cons: a user with one busy project can hit a lower limit while the store has room.

### Current state

- `b0dcf1660` (#1620) added retention: at the limit, the store clears a batch of up to 200 of the oldest finished records in the same locked write (`storage-coordinators.ts:146-174`), under the rules in `coordinator-workflow-retention.ts`. Request aliases carry arrival times and expire with the replay window. The report's "only recovery is deleting the project" no longer holds.
- Cleanup runs only at the limit (`storage-coordinators.ts:149`). Sweep cost below the limit is in [0110](0110-c3-sweep-and-reads.md#0110-the-sweep-and-every-snapshot-repeat-global-work).

## 0100: Delegations to a forgotten node never close

### Task analysis

#### Tasks

1. **Close work on forget**: forgetting a node closes its open delegations as `stopped`, marks its workflows reported and sends one notice. Status: open.
2. **Tell the coordinator about a long-offline node**: one notice after about 24 hours. Status: open.

#### 1. Close work on forget

**Problem.** The coordinator is never told, the Work panel counts the worker as running indefinitely, and the node is polled every minute for good.

**Context.** Treating an unreachable node as no news is right for a short outage. A forgotten node is different: it will not come back through this registry.

**Investigation.** `read` in `nodes/node-coordinator-remote.ts:51-63` turns every routing failure into `"unavailable"`. `reconcileRemoteDelegation` returns on that (`coordinator-service.ts:1105-1109`). `forgetNode` (`nodes/node-service.ts:745-779`) changes only the registry and tombstones. The handover path also forgets nodes (`:1146-1151`). These records also never become clearable: retention treats every `nodeId` record as existing and of unknown state (`coordinator-workflow-retention.ts:110`, `storage-coordinators.ts:182`), so they hold store slots for good.

**Decisions.**

- **Who owns the cleanup?**
  - **A `CoordinatorService.nodeForgotten(nodeId)` called after `forgetNode` succeeds, also from the handover path (recommended).**
    - Pros: all the wake and notice logic stays in one service; works with a tombstoned node whose detach is pending.
    - Cons: a hook to remember on any later path that removes a node.
  - **Have the sweep notice a `nodeId` missing from the registry.**
    - Pros: no hook, and it covers any removal path, plus records that already exist.
    - Cons: up to a minute's delay; the sweep needs a registry read.
- **Handover: is a moved node "forgotten" for this purpose?**
  - **Yes (recommended).** This coordinator can no longer reach it, so what it owed cannot arrive here.
    - Pros: one rule.
    - Cons: the work continues under the new command node, so the notice must say "no longer controlled here" rather than "stopped".
  - **No: leave those records alone.**
    - Pros: nothing claimed about a node that is still working.
    - Cons: the same stuck rows, for the same reason.

#### 2. Tell the coordinator about a long-offline node

**Problem.** A node offline for days leaves its workers shown as running, with no word to the coordinator.

**Context.** The delegation must stay open: the worker may finish, and collection on reconnect still delivers its report.

**Investigation.** `reconcileRemoteDelegation` has no offline clock. `workerState`'s `"unavailable"` carries no reason, so offline and a transient failure look alike. `lastContactAt` in `nodes/node-service.ts` tracks controllers; no last-seen time for a controlled node turned up.

**Decisions.** None: keep a first-unavailable time per node beside the service's other in-memory maps (`coordinator-service.ts:180-187`), and send one idempotent notice per node per offline episode. A restart only restarts the clock.

### Needs verification

Reported in the report and confirmed by reading only; no node was forgotten live. Two-node behaviour needs a run on real machines.

## 0380: Duplicated request-alias lookup

### Task analysis

#### Tasks

1. **Share the lookup**: one helper for reading a request alias. Status: open.

#### 1. Share the lookup

**Problem.** Two copies of an idempotency lookup can drift, and a mismatch would decide whether work starts twice.

**Context.** Retention added alias timestamps, which raised the number of places aliases are read and written.

**Investigation.** `requestAlias` at `coordinator-review-actions.ts:34-45` (used at `:350-355`), against the inline form at `storage-coordinators.ts:613-630`.

**Decisions.** None: export one helper from `storage-coordinators.ts` or the retention module and use it in both.

## Related

- [Coordinator report, 4.2 (B1)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability)
- [Architecture: Workflow record limit and cleanup](../../architecture/coordinator.md#workflow-record-limit-and-cleanup)
- [Coordinator report, 4.2 (B4)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability)
- [Coordinator report, 6](../2026-10-27-coordinator.md#6-maintainability)
