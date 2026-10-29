---
id: 211
title: "Run view"
phase: 2
plan: "P2.11"
status: not-started
depends_on: [201, 204]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 211 · Run view

- **Plan:** [P2.11 Run view](../composable-graphs.md#p211-run-view)
- **Decisions:** D16, D17
- **Depends on:** [201](201-run-record-and-storage.md), [204](204-agent-node-executor.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Users watch and control a run in the same visual language as Multi Review and the Build Pipeline.

## Work

- [ ] Tab type `graph-run` in `apps/web/src/contexts/TerminalContext.tsx`.
- [ ] `graphRunFlowModel(plan, run)` over `apps/web/src/components/flow-graph/`: replicated activations share a column, loops unroll to the right, superseded activations collapse into "Previous attempt" nodes, nodes not yet reached are faded.
- [ ] Inspector: transcript (`PipelineSessionTranscript`), input and output artifacts rendered by type, profile and enforced tier, guard results.
- [ ] Actions: retry, restart from here, rewind code to here, skip, open session, approve/edit/choose, pause, resume, cancel.
- [ ] Rehydrate from snapshots only.

## Tests

- [ ] Projection unit tests.
- [ ] Component tests for faces, inspector and actions.
- [ ] Agent-testing run of the inactive-environment path: start, switch away, finish, return.

## Done when

- [ ] Runs are observable and controllable from the run view.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
