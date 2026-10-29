---
id: 212
title: "Editable designer"
phase: 2
plan: "P2.12"
status: not-started
depends_on: [107, 109, 110]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 212 · Editable designer

- **Plan:** [P2.12 Editable designer](../composable-graphs.md#p212-editable-designer)
- **Decisions:** D1, D9, D11, D13, D17
- **Depends on:** [107](107-compiler.md), [109](109-template-storage-and-trust.md), [110](110-canvas-spike-and-read-only-designer.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Users build and edit graphs on the canvas.

## Work

- [ ] Canvas: add, connect, delete and group (loop regions), with undo. Dragging from a port shows only compatible targets.
- [ ] Replication is a node setting drawn as a stacked "×N" card (D9). A new fan-in defaults to a `dedupe` merge (D11).
- [ ] Inspector forms: prompt; inputs and outputs; capabilities (profile, toggles, the per-provider tier matrix, `minEnforcement`); execution (role, replicate, retry, timeout, failure, session).
- [ ] Prompt editor: variable autocomplete from input schemas; live preview with the system contract, using type examples or a pasted fixture; size against the ceiling; lints.
- [ ] Type editor limited to the schema subset, plus "schema from example".
- [ ] Live compile panel and cost estimate. Saving uses compare-and-swap; a conflict offers "save as copy".
- [ ] Taint warnings need an acknowledgement, stored in the template against the warning's digest.

## Tests

- [ ] Component tests for each editor.
- [ ] Agent-testing run: build the design bake-off graph (report §9.3) from scratch and compile it clean.

## Done when

- [ ] A user can build, validate and save the report §9 examples on the canvas.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
