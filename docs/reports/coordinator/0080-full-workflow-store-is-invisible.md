# A full workflow store is invisible to the user

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Stop swallowing a failed delegation open**: `send_message` tells the coordinator when its message opened no delegation because of an error. Status: open.
2. **Show store-full to the user**: the panel says the store is full and what frees room. Status: open.
3. **Settle the shared cap**: decide whether one project may still use up the limit for all. Status: open.

### 1. Stop swallowing a failed delegation open

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

### 2. Show store-full to the user

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

### 3. Settle the shared cap

**Problem.** The report recommends a per-project cap; the code states the opposite on purpose. One project with many live or remote records can still block every other.

**Context.** `coordinator-workflow-retention.ts:4-7` says "shared on purpose", and `docs/architecture/coordinator.md:94-96` repeats it. Neither records why a per-project limit was rejected.

**Investigation.** Records of remote launches and legacy aliases never become clearable (`coordinator-workflow-retention.ts:110`, `storage-coordinators.ts:182`), so they can build up without limit. [0100](0100-forgotten-node-delegations-never-close.md) adds to that.

**Decisions.**

- **Per project, or shared?**
  - **Keep it shared, and record the reason in the code comment (recommended).**
    - Pros: the store is one file rewritten whole, so its total is what costs; a per-project limit does not bound that.
    - Cons: the noisy-neighbour case stays, softened by tasks 1 and 2.
  - **Add a per-project limit as well as the total.**
    - Pros: isolates a noisy project, which is the report's point.
    - Cons: a user with one busy project can hit a lower limit while the store has room.

## Current state

- `b0dcf1660` (#1620) added retention: at the limit, the store clears a batch of up to 200 of the oldest finished records in the same locked write (`storage-coordinators.ts:146-174`), under the rules in `coordinator-workflow-retention.ts`. Request aliases carry arrival times and expire with the replay window. The report's "only recovery is deleting the project" no longer holds.
- Cleanup runs only at the limit (`storage-coordinators.ts:149`). Sweep cost below the limit is in [0110](0110-sweep-and-snapshot-repeat-global-work.md).

## Related

- [Coordinator report, 4.2 (B1)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability)
- [Architecture: Workflow record limit and cleanup](../../architecture/coordinator.md#workflow-record-limit-and-cleanup)
