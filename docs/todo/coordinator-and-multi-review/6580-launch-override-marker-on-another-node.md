# Launch override marker on a worker tab on another node

## Task analysis

Analysed 2026-11-07 against unified-federation-b4c9ee65814d at `ae492c20c`. The task still applies, but its premise changed: plan items 6002 and 6003 deleted workspace realms, and another node's tab now renders in the window's own renderer on that node's scope, beside the command node's scope. The decision below is re-weighed for that; the realm-based option is gone.

Previously analysed 2026-11-05 against main at 41f9eb638, with to-do 4943 (the marker on a local worker's tab) applied.

### Tasks

1. **Mark the tab of a worker on another node when its launch overrode the default**: a local worker's tab has it; a worker a command node launched on a leaf does not. Status: open.

### 1. Mark the tab of a worker on another node when its launch overrode the default

**Problem.** A command node's coordinator can launch a worker on a leaf on a more expensive model than the default. Someone looking at that worker's tab sees no marker, although the same launch on this machine would have one. The command node's Work row does show "requested", so the fact is visible where the coordinator is, not where the worker is.

**Context.** Left by to-do 4943, which added the "requested" marker on the tab from `list_coordinator_launch_overrides`. The marker reads `coordinatorLaunchOverrideStore` (`apps/web/src/stores/coordinatorLaunchOverrideStore.ts`), a scoped store (plan item 3011): each node scope reads its own node's backend. Another machine's tabs render in the window's own renderer on that machine's node scope ([node scopes](../../architecture/federation.md#node-scopes-one-scope-per-node-in-the-windows-tree)), so a leaf's tab reads the leaf's store, which the leaf answers. The same window also holds the command node's scope, whose backend keeps the delegation. Before 6002 and 6003 the tab rendered in a separate realm document that could reach only the leaf.

**Investigation.** `coordinatorLaunchOverrides` (`packages/protocol/src/coordinator-launch-overrides.ts`) leaves out any association with a `nodeId`. The delegation and its `request.source` are kept on the command node (`open_coordinator_node_delegation`), so the leaf holds no such association. What the leaf does hold is the origin record the launch writes (`record_node_environment_origin`, called from `commands-registry-coordinator-nodes.ts`, stored through `leafMail.recordOrigin`): the environment, the controller and the coordinator's mailbox, with no selection. The handler rejects keys it does not know (`assertOnlyKeys`), so a newer command node sending one more key to an older leaf would fail that call unless the key is gated on a capability. A job launched into an existing environment on a leaf (`launch_control_job`) writes no origin record.

**Decisions.**

- **Where should a leaf's tab get the fact?**
  - **Answer it from the command node's scope: let the command node's read include associations with a `nodeId`, and have a leaf tab's marker look its tab up in the command scope's store by node (recommended).**
    - Pros: no stored field on the leaf and no capability gate for older leaves; nothing new is written on the leaf for a job launched into an existing environment (whether that job's delegation carries the tab on the command node needs checking); the window already holds the command scope, so no new channel is needed.
    - Cons: the marker is missing when the leaf is opened directly as its own command node, or while the command node is unreachable; the protocol's `coordinatorLaunchOverrides` must carry `nodeId`, so an older renderer must ignore those entries (it keys by environment and tab, so a node-qualified key is needed).
  - **Send the source with the origin record and answer it from the leaf's own read.**
    - Pros: the tab keeps reading only its own backend; it still works while the command node is offline, and when the leaf is opened directly rather than through the command node.
    - Cons: one more stored field on the leaf, which to-do 4943 avoided for local workers; needs a capability check for older leaves; a job on a leaf needs its own write, since it records no origin.
  - **Leave the tab unmarked.**
    - Pros: no work; the Work row on the command node already says it.
    - Cons: the place someone looks later stays silent for exactly the workers furthest from the coordinator.

## Assumptions and decisions

### Task 1: recommendation moved to the command scope (2026-11-07)

The earlier recommendation (store the source on the leaf) rested on the realm boundary: a realm could reach only its leaf, and the option of handing the answer across it had no channel. Node scopes (6002, 6003) removed that boundary, so reading the command scope's store from the leaf's tab became the cheaper option, and the realm option was dropped. The task stays open; nothing was built.

## Related

- [Launch defaults](../../architecture/coordinator.md#launch-defaults)
