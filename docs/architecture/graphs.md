# Graphs

Status: Living. Started with the canvas spike (item 110, 2026-10-29). It
describes what has shipped of the composable-graphs plan
([`plans/composable-graphs.md`](../../plans/composable-graphs.md)); item 216
completes it with the runtime and a user guide.

## Overview

A **graph** is a typed workflow template: nodes (agent, system, gate, merge,
human, sub-graph) joined by edges that carry typed artifacts, with bounded loop
regions. The feature is called "Graphs" in the UI (D17). Multi Review, the
Build Pipeline and Looped Review are described as built-in templates, but run
on their own engines (D5); a duplicate of one runs on the graph runtime once
Phase 2 ships it.

What exists so far, all browser-safe under `packages/protocol/src/graphs/`
unless noted:

| Part | Where | What it does |
| --- | --- | --- |
| Template schema (101) | `template.ts`, `template-model.ts`, `template-nodes.ts`, `grammar.ts` | `GraphTemplateV1` with hand-written guards and byte/count bounds. `layout` holds designer positions by node id; the compiler and digests ignore it. |
| Type library (102) | `types.ts`, `artifact-type-def.ts`, `schema-subset.ts`, `type-assignability.ts` | Built-in artifact types, custom `ArtifactTypeDef`s limited to a cross-provider schema subset, assignability and edge transforms. `graphTypeFamily(ref, library?)` gives each type a family (`text`, `ticket`, `report`, `workspace`, `decision`, `package`, `error`, `list`, `unknown`) that colours ports. |
| Result-kind registry (103) | `output-slots.ts`, `provenance.ts`, backend registry | The `graph-output` result kind: one submit tool per output port. |
| Predicates (104) | `predicates.ts`, `predicate-eval.ts` | Bounded JSON predicates for `when`, gate branches, loop `until` and edge filters. |
| Prompts (105) | `prompts.ts`, `prompt-*.ts`, `system-contract.ts` | Logic-less prompt templates, render modes, size estimates and lints. |
| Capability profiles (106) | `capability-profiles.ts`, `capability-enforcement.ts` | Profiles compiled to a `NativeAgentExecutionPolicy`; `agentPolicyEnforcementMatrix` rates each provider `enforced`, `provider-configured` or `advisory`. |
| Compiler (107) | `compile.ts` and `compile-*.ts`, `plan.ts`, `cost.ts` | `compile(template, options)` returns diagnostics (located by `nodeId`, `edgeId`, `loopId`, `path`), a hashed plan when there are no errors, and a cost estimate (best and worst agent sessions, peak parallelism). It never throws. |
| Built-ins (108) | `builtins/` | The three built-in templates, pinned to their engines by tests. Looped Review's engine is retired (`engineStatus: "retired"`). |
| Library and trust (109) | `library.ts`; backend `graph-template-service.ts`, `commands-registry-graphs.ts`; web `lib/backend/graph-templates.ts` | Built-in, user (backend store, revision compare-and-swap) and project (`.orkestrator/graphs/*.graph.json`) templates; project templates are untrusted until the user approves their digest; a per-project capability ceiling; the `graph_template*` commands. |
| Run record (201) | `run.ts`, backend `graph-runs` store | Run, activation and artifact records for the Phase 2 runtime. |
| Designer (110) | `apps/web/src/components/graph-designer/` | The read-only Graphs designer tab (below). |

## Canvas library decision (spike, 2026-10-29)

**Decision:** the Graphs designer uses React Flow (`@xyflow/react`), pinned
exactly at `12.12.0` (MIT). The run view stays on `components/flow-graph/`.
Revisit 13.x when stable: it is compiled with the React Compiler and uses
zustand 5, which removes the duplicate zustand 4 copy.

**Evidence (100 nodes, 153 edges, headless Chromium, production bundle):**
mount 49–60 ms (in-house 37–57 ms); 4× CPU throttle 139–150 ms (in-house
153–164 ms); node drag ~0.85 ms script per pointer step, with no frame over
16.8 ms. Bundle: +58.6 KB gzip JS and +3.0 KB gzip CSS, so the designer tab is
lazy-loaded with `lazy()`. Editing in-house would mean rewriting the viewport
(drag, hit-testing, connection drag, selection, groups, unbounded canvas,
minimap); React Flow provides those.

The spike compared both against the plan's criteria (P1.10):

- **Keyboard and screen readers.** The in-house nodes are `role="tab"` in a
  tablist with one tab stop and arrows/Home/End/Enter. React Flow makes every
  node and edge a tab stop with `role="group"` and an aria-live region, but
  `ariaRole`, `ariaLabel` and `domAttributes.tabIndex` can be set per node, so
  the flow-graph pattern can be kept.
- **Theming.** React Flow's styles are scoped to `.react-flow*`, use no
  `@layer`, and expose 85 `--xy-*` variables; `colorMode="dark"` exists.
- **Loop regions.** `type: "group"` nodes with `parentId` and
  `extent: "parent"` work; the in-house renderer has nothing to build on.
- **Performance at 100 nodes.** Comparable (numbers above).
- **Bundle and licence.** MIT; 180 KB min / 58.6 KB gzip. It ships its own
  zustand 4.5.7 beside the app's zustand 5 (upstream #5685).
- **Maintenance.** 12.12.0 shipped 2026-09-24, with monthly releases.

**Integration notes**

- CSS: in `apps/web/src/index.css`, after `@import "tailwindcss"`, add
  `@import "@xyflow/react/dist/style.css" layer(base);` so utilities override
  it. Map tokens on `.react-flow`: `--xy-background-color:
  var(--color-flow-canvas)`, `--xy-node-background-color:
  var(--color-flow-node)`, `--xy-edge-stroke: var(--color-flow-edge)`. Pass
  `colorMode="dark"` when the app is dark.
- Attribution: set `proOptions={{ hideAttribution: true }}` (MIT allows it; the
  default link would open an external page in Electron).
- Typed ports: handle id `in:<port>` / `out:<port>` carrying the type family;
  `<ReactFlow isValidConnection>` accepts a connection only when types are
  assignable. Custom nodes read `useConnection().fromHandle` to set
  `isConnectableEnd` on compatible targets and dim the rest. The compiler
  remains the authority.
- Loop regions: each region is a `type: "group"` node; member nodes get
  `parentId` and `extent: "parent"`, positions relative to the group; parents
  before children in the array. Positions are saved to the template's `layout`.
- Accessibility: keep the flow-graph pattern. `domAttributes.tabIndex = -1` on
  all nodes except the active one, arrow keys in topological order, `ariaLabel`
  per node, `edgesFocusable={false}` with edges listed in the inspector.
  Keyboard "Connect to…" and "Move into loop" commands for editing. Phase 1 is
  read-only (`nodesDraggable={false}`, `nodesConnectable={false}`).
- Undo: our own command stack over template edits.
- Tests: stub `ResizeObserver`, `DOMMatrixReadOnly` and
  `offsetWidth`/`offsetHeight` under happy-dom; assert geometry in Playwright.
- Hidden tabs: do not wrap the canvas in `<Activity>` (upstream #6044).
