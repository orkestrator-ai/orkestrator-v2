# Coordinator worker surfaces: follow-ups

Checked against `main` at `863b5782` (2026-10-27).

The worker surfaces built for
[0142-coordinator-product-surfaces.md](0142-coordinator-product-surfaces.md)
(terminal, browser, tab edits, reviewer tabs, custom fix, feature plans,
the root-changes request) act on this node only, and feature plans never
wake the coordinator. (A looped review surface was also built; it was removed
with the Looped Review feature.) This file holds the work those decisions
left.

## Current state

- The tools and their backend commands are described in
  [`coordinator.md`, "Worker surfaces"](../../architecture/coordinator.md#worker-surfaces).
- The new backend commands are on `NODE_EXCLUDED_COMMANDS`
  (`apps/backend/src/core/nodes/node-routing.ts`), so none of them crosses a
  node link; `open_multi_review` refuses `reviewerId` with `nodeId`.
- Feature plans have no `CoordinatorWorkflowAssociation` kind, so `list_workflows` does not list them and status wakes
  (`coordinator-status-wakes.ts`) never report them. Their tool results say
  so and point at `create_schedule`.

## Outstanding work

### Code

1. **The same tools on other nodes.** `nodeId` on `launch_terminal`,
   `open_worker_browser`, `edit_worker_tab`, `custom_fix_multi_review` and `open_multi_review` with `reviewerId`,
   relayed like `launch_coordinator_node_multi_review`, with the
   outcome-unknown path a lost answer needs. `request_root_changes` across
   nodes needs the patch to travel from this node's checkout to a leaf
   worker (or the leaf's own checkout to be the source).
2. **Status wakes for feature plans.** An association kind, listed by
   `list_workflows`, and status-wake rules (planning reply ready, failed) with the same ownership, budget
   and restart guarantees as Multi Review.
3. **Live coordinator suite scenario.** A `surfaces` scenario in
   `mise run test:agent:coordinator` that calls each tool once and checks the
   resulting tabs and the root-changes approval on a real stack.

## Constraints and rationale

- The read-only boundary does not move: nothing here may write to the
  project checkout, and the root-changes patch still needs the user's
  approval.

## Open questions

- Should a feature plan started by the coordinator be
  adoptable like other workflows (`adopt_workflow`)?

## Needs verification

- Nothing yet.

## Related

- [0142-coordinator-product-surfaces.md](0142-coordinator-product-surfaces.md)
- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
  for the live suite.

## Replaces

- Nothing.
