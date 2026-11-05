# Live checks for workflow records on released and unreachable nodes

## Task analysis

Analysed 2026-11-05 against main at 41f9eb638, with coordinator batch C2 (Workflow records) applied.

### Tasks

1. **Forget a real node that has running coordinator work**: needs two real machines. Status: open.
2. **Hand a real node with running work to another command node**: needs three real machines. Status: open.
3. **A real node offline for a day, then back**: needs two real machines and a day. Status: open.
4. **The workflow store banner on a live stack**: needs a store near its limit on an isolated profile. Status: open.

### 1. Forget a real node that has running coordinator work

**Problem.** Closing a forgotten node's work has been proved only with a simulated leaf. Nothing has shown it on two machines with a real node link.

**Context.** From coordinator report C2, part `0100`, task 1, and its Needs verification section ("Two-node behaviour needs a run on real machines"). The batch could not contact other real nodes or forget one.

**Investigation.** `coordinator-node-release.test.ts` drives `CoordinatorService.nodesReleased` on the real mail world with a fake remote: the delegation closes as `stopped` with `wokenAt`, a remote pipeline is marked reported, one notice arrives, and nothing on the node is read again. `nodes/node-service.test.ts` shows `forgetNode` calling `onNodesReleased` once, after the registry write, on a simulated network. The composition root (`apps/backend/src/core/index.ts`) wires the two together; no run joined them.

**Decisions.**

- **How to check it?**
  - **On two dev machines, delegate a long task to a worker on the leaf, forget the leaf, and read the coordinator's mail and the Work panel (recommended).**
    - Pros: the real hook, the real registry write and the real notice in one run.
    - Cons: costs one provider turn on the leaf, and needs two machines.
  - **Rely on the fake-network tests.**
    - Pros: no cost.
    - Cons: the wiring in `index.ts` is the one part no test exercises.

### 2. Hand a real node with running work to another command node

**Problem.** The handover notice ("no longer controlled here") has been shown only on the mail world, with the hook called directly.

**Context.** From coordinator report C2, part `0100`, task 1 (its handover decision). `nodes/node-handover.test.ts` shows `completeHandover` releasing the target and the machines it takes, reason `handed-over`, on a simulated network.

**Investigation.** The released set is the handover target plus `movingIds`, read in the same registry write that forgets them. A handover interrupted after that write, and resumed by `completeHandover` on startup, releases through the same call. Not seen with real machines.

**Decisions.**

- **How to check it?**
  - **Delegate work to a leaf, hand that leaf (and another) to a second command node, and confirm one notice per coordinator saying the work is no longer controlled here (recommended).**
    - Pros: covers the wording that differs from forget, and a real handover's timing.
    - Cons: needs three machines and a handover, which changes which machine controls the others.
  - **Check only forget live, and trust the shared path.**
    - Pros: one fewer setup.
    - Cons: the target is released by a different line of the handover path.

### 3. A real node offline for a day, then back

**Problem.** The once-per-episode notice after about 24 hours, and report collection on reconnect, have only fake-clock evidence.

**Context.** From coordinator report C2, part `0100`, task 2. The clock is in memory (`CoordinatorNodeReleases`), so a backend restart restarts it.

**Investigation.** `coordinator-node-release.test.ts` moves the system clock across `NODE_OFFLINE_NOTICE_MS`, checks one notice per episode, a second episode after an answer, and that a held report is collected and delivered as the wake on reconnect. A real link's failure modes (SSH tunnel down, route unreachable, a node answering some reads but not others) were not exercised.

**Decisions.**

- **How to check it?**
  - **Delegate to a leaf, power it off for a day with the command node running, then bring it back with a report waiting (recommended).**
    - Pros: the real failure the feature is for.
    - Cons: a day of wall-clock time, and the command node must not restart in between.
  - **Shorten the threshold on a dev build (`nodeOfflineNoticeMs`) and unplug the leaf for minutes.**
    - Pros: fast.
    - Cons: needs a dev build that sets the option, which no production path does.

### 4. The workflow store banner on a live stack

**Problem.** The banner was screenshotted as the real component with the app's compiled styles, not inside a running app with a store near its limit.

**Context.** From coordinator report C2, part `0080`, task 2. Filling the store needs about 1,800 records still in use, which no fixture seeds.

**Investigation.** `CoordinatorWorkflowStoreBanner.test.tsx` covers the three states; `coordinator-workflow-retention.test.ts` covers the snapshot state on a real store; `coordinator-node-release.test.ts` reads `workflowStore` from a real snapshot (`ok`). The banner's place in `CoordinatorWorkArea` above the worker prompts was not seen live.

**Decisions.**

- **How to check it?**
  - **Add a `dev:test` fixture option that seeds in-use coordinator records, then open the panel at desktop and phone widths (recommended).**
    - Pros: repeatable, and it exercises the snapshot through the gateway.
    - Cons: a new fixture option to maintain.
  - **Seed records by hand into a disposable profile's store.**
    - Pros: no harness change.
    - Cons: writes a store behind the running backend's back, which the storage rules forbid.

## Related

- Architecture: [Workflow record limit and cleanup](../../architecture/coordinator.md#workflow-record-limit-and-cleanup) and [Work on a node that leaves](../../architecture/coordinator.md#work-on-a-node-that-leaves)
- [4942-c7-live-checks.md](4942-c7-live-checks.md), the other two-node live checks
