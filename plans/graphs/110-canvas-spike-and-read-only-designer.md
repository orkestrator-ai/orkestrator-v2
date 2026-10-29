---
id: 110
title: "Canvas spike and read-only designer"
phase: 1
plan: "P1.10"
status: done
depends_on: [107, 108, 109]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1436"
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
- [x] Tab type `graph-designer` in `apps/web/src/contexts/TerminalContext.tsx`, named "Graphs" in the UI.
- [x] Library list (built-in, user, project, with trust state).
- [x] Canvas with typed ports coloured by type family; read-only inspector.
- [x] Compile panel with diagnostics pinned to nodes and edges, and the cost estimate.
- [x] JSON import and export; "Duplicate" creates an editable user template.

## Tests

- [x] Component tests for the library, canvas, inspector and compile panel.
- [x] Agent-testing (Playwright) run: open the designer, view a built-in, import JSON, see diagnostics (`docs/development/agent-testing.md`).

## Done when

- [x] The canvas library is chosen and recorded, and the read-only designer ships.

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

**2026-10-29 · Designer: files and APIs.** Web only; nothing in the backend or protocol changed.
`apps/web/src/components/graph-designer/`: `GraphDesignerTab.tsx` (lazy-loaded tab root),
`GraphLibraryList.tsx`, `GraphCanvas.tsx` + `GraphCanvasNodes.tsx` (React Flow; node types
`graph-node`, `graph-io`, `graph-loop`, exported as `GRAPH_CANVAS_NODE_TYPES`), `GraphInspector.tsx`,
`GraphCompilePanel.tsx` (`GraphDiagnosticRow`, `graphDiagnosticTarget`), `GraphImportDialog.tsx`,
`GraphJsonEditor.tsx`, `graph-designer-model.ts` (`buildGraphCanvasModel({template, plan?,
diagnostics?})` → `{nodes, edges, order, layout, undrawnEdges, diagnostics}`;
`indexGraphDiagnostics`, `GRAPH_TYPE_FAMILY_COLORS`, `graphPlanValueTypeFamily`,
`graphTemplateTypeLibrary`), `graph-designer-layout.ts` (`layoutGraphTemplate`,
`graphTemplateOrder`, `GRAPH_INPUTS_NODE_ID = "$inputs"`, `GRAPH_OUTPUTS_NODE_ID = "$outputs"`),
`graph-designer-open-tab.ts` (`openGraphDesignerTab`), test support `react-flow.test-support.ts`
(`installReactFlowDomStubs`) and `graph-designer.test-fixtures.ts`. Store
`apps/web/src/stores/graphDesignerStore.ts` (`useGraphDesignerStore`: `libraries: Map<projectId,
…>`, `tabs: Map<tabId, …>`; actions `loadLibrary`, `openTemplate`, `refreshTab`, `select(tabId,
selection, focus?)`, `importTemplate`, `duplicateTemplate`, `exportTemplate`, `setTrust`,
`openEditor`/`editDraft`/`compileDraft`/`saveDraft`/`reloadDraft`/`closeEditor`;
`parseGraphDraft`, `isGraphRevisionConflict`). Tab plumbing: `TabType`/`CreatableTabType`
`"graph-designer"`, `CreateTabOptions.graphTemplate`, `TabInfo.graphDesignerData = {selected?}`,
`paneLayoutStore.updateTabGraphDesigner`, restore in `pane-layout-restore.ts` (shape check only,
so the protocol library and built-ins stay out of the main bundle), tab chrome "Graphs N".

**2026-10-29 · Designer: decisions.**
- Entry point: a **Graphs** button in the environment action bar (network icon; Linear already
  uses the workflow icon). One designer tab per environment; opening again focuses it. 214 adds
  "Run graph…" and the designer's Run/Mock run.
- Canvas handles: `in:<port>`, `out:<port>`, and `outlet:<name>` on gate and human nodes (an
  outlet forwards the node's inputs, so it is untyped); run inputs and outputs are the `$inputs` and
  `$outputs` pseudo-nodes; carries are dashed `carry:<loopId>#<i>` edges; run outputs dotted
  `output:<name>` edges. Edges to a missing node or port are not drawn (`undrawnEdges`); the
  compiler's diagnostic says why. Edge colour is the plan's delivered type, else the producer's
  declared type; edges with errors are red.
- Layout: `template.layout` only when it places every node (a partial layout is ignored rather
  than mixed); otherwise longest-path layers with one band of rows per loop, so a loop frame holds
  only its members. A graph too wide to read when fitted opens at zoom 0.6 on its start.
- Node face badges: the enforcement badge is the node's effective floor (`≥ Provider-configured`);
  replication is `×N` from the plan's fan-out (`×panel`/`×N` from the spec before compile).
- Keyboard: React Flow's own keys are off (`disableKeyboardA11y`); one tab stop
  (`domAttributes.tabIndex`), arrows/Home/End in the plan's topological order, Enter/Space selects,
  `ariaRole: "button"` with `aria-pressed` and an `ariaLabel` per node. Selection is the store's
  (`elementsSelectable` false); clicking a diagnostic selects and centres its node, edge or loop.
- Compile: stored templates by the backend (`graph_template_compile`, `includePlan: true`, project
  ceiling); a JSON draft in the browser with `compile()` (debounced 250 ms, ceiling from the
  library, enabled providers from settings, host `GRAPH_COMPILE_DEFAULT_HOST`). The inspector's
  enforcement matrix uses the plan's compiled capabilities, else `compileGraphCapabilities` in the
  browser, rated against `GRAPH_COMPILE_DEFAULT_HOST` (said in the UI).
- JSON editing of user templates is a textarea with save by `graph_template_save` and
  `expectedRevision` = the revision the edit started from; a `revision-conflict` keeps the text and
  offers "Reload latest". The gateway forwards only the message, so the conflict is recognised by
  `code` or by the backend's message.
- Approve passes the digest of the summary shown; Duplicate of a project template passes it too.
- Rehydration: only `{selected}` is in the pane layout; library and template are re-read on mount,
  `graph-template` changes and view safety checks. Switching environments and reloading were checked
  in the real stack.

**2026-10-29 · For 211/212.** 212 should reuse `buildGraphCanvasModel` (handle ids, loop groups,
`parentId`/`extent: "parent"`), `GraphCanvasNodes` (add `isConnectable`/`useConnection` per the
spike notes), `GraphInspector` sections as the read-only half of its forms, `GraphCompilePanel`,
the store's draft path (`editDraft`/`compileDraft`/`saveDraft` with CAS and conflict handling) and
`installReactFlowDomStubs` for tests; saving positions writes `template.layout` (the layout honours
it only when complete). 211 stays on `flow-graph/` (D16) but can reuse `GRAPH_TYPE_FAMILY_COLORS`,
`indexGraphDiagnostics` and the tab plumbing pattern (`graph-designer-open-tab.ts`).

**2026-10-29 · Tests and evidence.** Component and store tests (happy-dom, React Flow stubs):
`GraphCanvas.test.tsx`, `GraphLibraryList.test.tsx`, `GraphInspector.test.tsx`,
`GraphCompilePanel.test.tsx`, `GraphDesignerTab.test.tsx`, `graph-designer-model.test.ts`,
`graph-designer-open-tab.test.ts`, `stores/graphDesignerStore.test.ts`, and a restore case in
`lib/pane-layout-restore.test.ts` (95 tests in these files). Real stack:
`e2e/agent-testing/graph-designer.spec.ts`, added to the browser suite
(`playwright.browser.config.ts`), run against an isolated `dev:test --fixture
--no-agent-credentials` profile (`graphs-110`, stopped and reset afterwards): opens Graphs from the
action bar, views the Build Pipeline built-in (canvas, loop, clean compile, cost), inspects a node
and moves with the keyboard, imports refused JSON (guard errors shown) and then a template with an
edge type mismatch (diagnostics on the edge and node; clicking one centres the edge), switches
environments and reloads (rehydrated), approves a project template in the fixture checkout,
duplicates a built-in and opens its JSON editor, and checks a narrow viewport. Screenshots under
`output/agent-testing/graphs-110/browser/artifacts/` (not committed). Bundle check: React Flow and
the compiler are only in the lazy `GraphDesignerTab` chunk; its CSS is in the main stylesheet
(`@import … layer(base)`, ~3 KB gzip), as the spike planned.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 · Spike recorded (React Flow 12.12.0) in Notes and `docs/architecture/graphs.md`; the spike ran before 107–109 landed, which its Notes allow. · Build the read-only designer.
- 2026-10-29 · Claude Opus 5.5 · Read-only designer: tab, library with trust, React Flow canvas, inspector, compile panel, import/export, Duplicate and JSON editing; component, store and Playwright tests; complete; awaiting PR.
- 2026-10-29 · coordinator · Delivered in https://github.com/orkestrator-ai/orkestrator-v2/pull/1436; status done. · None.
