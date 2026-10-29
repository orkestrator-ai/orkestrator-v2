---
id: 110
title: "Canvas spike and read-only designer"
phase: 1
plan: "P1.10"
status: in-progress
depends_on: [107, 108, 109]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-110-designer"
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

- [x] Spike, time-boxed: React Flow (`@xyflow/react`) against extending the in-house renderer. Criteria: keyboard and screen-reader support, Tailwind v4 and shadcn theming, grouping for loop regions, performance at 100 nodes, bundle size and licence. Record the result in this file's notes and in `docs/architecture/graphs.md`.
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

**2026-10-29 · Spike result: React Flow.** The designer uses React Flow (`@xyflow/react`), pinned
exactly at `12.12.0` (MIT); the run view stays on `components/flow-graph/` (D16, report §7.8).
Measured at 100 nodes / 153 edges in headless Chromium on a production bundle (median of 7
loads): mount 49–60 ms against the in-house renderer's 37–57 ms; under 4× CPU throttle 139–150 ms
against 153–164 ms; node drag ~0.85 ms script per pointer step, p95 frame 16.8 ms (the in-house
renderer has no node drag). Bundle +58.6 KB gzip JS and +3.0 KB gzip CSS, so the designer is
lazy-loaded; React Flow bundles its own zustand 4.5.7 (upstream #5685). Keyboard: the in-house
pattern (one tab stop, arrows/Home/End/Enter) is kept by overriding React Flow's per-node
`ariaRole`, `ariaLabel` and `domAttributes.tabIndex`. Theming: styles scoped to `.react-flow*`,
85 `--xy-*` variables, imported into Tailwind's `base` layer. Loop regions: `type: "group"` nodes
with `parentId` work; the in-house renderer has nothing for grouping, dragging, connecting or
selection. happy-dom renders nodes but no edges unless tests stub `ResizeObserver`,
`DOMMatrixReadOnly` and `offsetWidth`/`offsetHeight`. Avoid `<Activity mode="hidden">` around the
canvas (upstream #6044). Full write-up and integration notes:
[`docs/architecture/graphs.md`](../../docs/architecture/graphs.md#canvas-library-decision-spike-2026-10-29).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 · Spike recorded (React Flow 12.12.0) in Notes and `docs/architecture/graphs.md`; the spike ran before 107–109 landed, which its Notes allow. · Build the read-only designer.
