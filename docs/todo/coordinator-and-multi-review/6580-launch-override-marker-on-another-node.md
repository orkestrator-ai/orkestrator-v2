# Launch override marker on a worker tab on another node

## Task analysis

Analysed 2026-11-05 against main at 41f9eb638, with to-do 4943 (the marker on a local worker's tab) applied.

### Tasks

1. **Mark the tab of a worker on another node when its launch overrode the default**: a local worker's tab has it; a worker a command node launched on a leaf does not. Status: open.

### 1. Mark the tab of a worker on another node when its launch overrode the default

**Problem.** A command node's coordinator can launch a worker on a leaf on a more expensive model than the default. Someone looking at that worker's tab sees no marker, although the same launch on this machine would have one. The command node's Work row does show "requested", so the fact is visible where the coordinator is, not where the worker is.

**Context.** Left by to-do 4943, which added the "requested" marker on the tab from `list_coordinator_launch_overrides`. Another machine's tabs render in that machine's realm, which reads that machine's backend ([machine panels](../../architecture/federation.md#machine-panels-one-realm-per-machine)). A marker on such a tab can only be answered by the leaf.

**Investigation.** `coordinatorLaunchOverrides` (`packages/protocol/src/coordinator-launch-overrides.ts`) leaves out any association with a `nodeId`. The delegation and its `request.source` are kept on the command node (`open_coordinator_node_delegation`), so the leaf holds no such association. What the leaf does hold is the origin record the launch writes (`record_node_environment_origin`, called from `commands-registry-coordinator-nodes.ts`, stored through `leafMail.recordOrigin`): the environment, the controller and the coordinator's mailbox, with no selection. The handler rejects keys it does not know (`assertOnlyKeys`), so a newer command node sending one more key to an older leaf would fail that call unless the key is gated on a capability. A job launched into an existing environment on a leaf (`launch_control_job`) writes no origin record.

**Decisions.**

- **Where should a leaf's tab get the fact?**
  - **Send the source with the origin record and answer it from the leaf's own read (recommended).**
    - Pros: the tab keeps reading only its own backend; it still works while the command node is offline, and when the leaf is opened directly rather than through the command node.
    - Cons: one more stored field on the leaf, which to-do 4943 avoided for local workers; needs a capability check for older leaves; a job on a leaf needs its own write, since it records no origin.
  - **Have the command node's window hand the answer to the realm.**
    - Pros: no stored field; the record stays on the command node.
    - Cons: the realm boundary has no such channel, and the marker would be missing whenever the leaf is opened directly.
  - **Leave the tab unmarked.**
    - Pros: no work; the Work row on the command node already says it.
    - Cons: the place someone looks later stays silent for exactly the workers furthest from the coordinator.

## Related

- [Launch defaults](../../architecture/coordinator.md#launch-defaults)
