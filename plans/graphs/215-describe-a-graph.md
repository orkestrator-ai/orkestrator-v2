---
id: 215
title: "\"Describe a graph\""
phase: 2
plan: "P2.15"
status: not-started
depends_on: [103, 107, 212]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 215 · "Describe a graph"

- **Plan:** [P2.15 "Describe a graph"](../composable-graphs.md#p215-describe-a-graph)
- **Decisions:** D1, D6
- **Depends on:** [103](103-result-kind-registry.md), [107](107-compiler.md), [212](212-editable-designer.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Users can describe a graph in words and get a valid draft in the designer.

## Work

- [ ] A built-in agent flow that submits a `graph-template` artifact whose schema is the template schema.
- [ ] Compiler diagnostics fed back as repair prompts through the existing repair loop.
- [ ] The result opens in the designer as an unsaved draft and never runs until the user saves it.
- [ ] Not exposed to the coordinator (D6).

## Tests

- [ ] A fake provider's invalid draft is repaired using the diagnostics.
- [ ] A draft cannot be launched before it is saved.

## Done when

- [ ] "Describe a graph" produces compiling drafts in the designer.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
