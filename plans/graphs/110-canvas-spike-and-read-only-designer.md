---
id: 110
title: "Canvas spike and read-only designer"
phase: 1
plan: "P1.10"
status: not-started
depends_on: [107, 108, 109]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 110 · Canvas spike and read-only designer

- **Plan:** [P1.10 Canvas spike and read-only designer](../composable-graphs.md#p110-canvas-spike-and-read-only-designer)
- **Decisions:** D1, D16, D17
- **Depends on:** [107](107-compiler.md), [108](108-builtin-templates.md), [109](109-template-storage-and-trust.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Pick the canvas library, then ship a read-only Graphs designer that shows built-in, user and project templates with live diagnostics.

## Work

- [ ] Spike, time-boxed: React Flow (`@xyflow/react`) against extending the in-house renderer. Criteria: keyboard and screen-reader support, Tailwind v4 and shadcn theming, grouping for loop regions, performance at 100 nodes, bundle size and licence. Record the result in this file's notes and in `docs/architecture/graphs.md`.
- [ ] Tab type `graph-designer` in `apps/web/src/contexts/TerminalContext.tsx`, named "Graphs" in the UI.
- [ ] Library list (built-in, user, project, with trust state).
- [ ] Canvas with typed ports coloured by type family; read-only inspector.
- [ ] Compile panel with diagnostics pinned to nodes and edges, and the cost estimate.
- [ ] JSON import and export; "Duplicate" creates an editable user template.

## Tests

- [ ] Component tests for the library, canvas, inspector and compile panel.
- [ ] Agent-testing (Playwright) run: open the designer, view a built-in, import JSON, see diagnostics (`docs/development/agent-testing.md`).

## Done when

- [ ] The canvas library is chosen and recorded, and the read-only designer ships.

## Notes

- The spike does not depend on 107–109 and may start early. Say so in the log when it does.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
