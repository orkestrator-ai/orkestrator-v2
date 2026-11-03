# Delegations to a forgotten node never close

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Close work on forget**: forgetting a node closes its open delegations as `stopped`, marks its workflows reported and sends one notice. Status: open.
2. **Tell the coordinator about a long-offline node**: one notice after about 24 hours. Status: open.

### 1. Close work on forget

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

### 2. Tell the coordinator about a long-offline node

**Problem.** A node offline for days leaves its workers shown as running, with no word to the coordinator.

**Context.** The delegation must stay open: the worker may finish, and collection on reconnect still delivers its report.

**Investigation.** `reconcileRemoteDelegation` has no offline clock. `workerState`'s `"unavailable"` carries no reason, so offline and a transient failure look alike. `lastContactAt` in `nodes/node-service.ts` tracks controllers; no last-seen time for a controlled node turned up.

**Decisions.** None: keep a first-unavailable time per node beside the service's other in-memory maps (`coordinator-service.ts:180-187`), and send one idempotent notice per node per offline episode. A restart only restarts the clock.

## Needs verification

Reported in the report and confirmed by reading only; no node was forgotten live. Two-node behaviour needs a run on real machines.

## Related

- [Coordinator report, 4.2 (B4)](../2026-10-27-coordinator.md#42-backend-correctness-and-durability)
- [0080-full-workflow-store-is-invisible.md](0080-full-workflow-store-is-invisible.md)
