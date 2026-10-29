---
id: 209
title: "Guards and enforcement"
phase: 2
plan: "P2.9"
status: not-started
depends_on: [001, 106, 204]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 209 · Guards and enforcement

- **Plan:** [P2.9 Guards and enforcement](../composable-graphs.md#p29-guards-and-enforcement)
- **Decisions:** D4, D12
- **Depends on:** [001](001-pipeline-reviewers-read-only.md), [106](106-capability-profiles.md), [204](204-agent-node-executor.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

What a profile promises is either enforced by the provider or detected by a guard, and the user can see which.

## Work

- [ ] Apply the read-only guard from [001](001-pipeline-reviewers-read-only.md) to every node with `workspaceAccess: read` or `none`.
- [ ] A remote-ref guard compares upstream refs before and after every agent node (none may push).
- [ ] Withhold the GitHub credential from agent session environments where the provider allows it.
- [ ] `minEnforcement` filters pickers at launch and is re-checked at dispatch; a tier that dropped since launch fails the activation before dispatch.
- [ ] Record the applied tier on the activation and show it in the inspector.

## Tests

- [ ] A committing reviewer is refused (fake providers here; live runs batched in todo 0031).
- [ ] A push attempt is detected.
- [ ] A tier drop fails before dispatch with a clear message.

## Done when

- [ ] Guards and enforcement checks are in place, and the tiers shown match live conformance runs.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
