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
| Mock runs (213) | `mock.ts` (`mock-pins.ts`, `mock-values.ts`, `schema-sample.ts`); backend `graph-mock-provider.ts`, `graph-mock-outputs.ts`, `graph-mock-system.ts`, `graph-mock-launch.ts`, `commands-registry-graph-mock.ts`; web `lib/backend/graph-mock.ts`, `lib/graph-run-navigation.ts`, `GraphMockPinsEditor.tsx` | Runs a stored template with canned answers on the real runtime: no provider sessions, no tokens, no side effects (below). |
| Designer (110, 212) | `apps/web/src/components/graph-designer/`, `apps/web/src/stores/graphDesignerStore.ts` | The Graphs designer tab: library, canvas, inspector and compile panel; user templates and new graphs are edited on the canvas (below). |

## The Graphs designer (items 110 and 212)

**Opening it.** The environment action bar's **Graphs** button (network icon)
calls `createTab("graph-designer")`; an optional `graphTemplate` ref opens it
on a template. There is one designer tab per environment: opening it again
focuses it (`openGraphDesignerTab`, `components/graph-designer/graph-designer-open-tab.ts`).
The tab chrome reads "Graphs N" (D17). The component is lazy-loaded from
`PaneLeafContainer`, so React Flow and the compiler stay out of the main bundle.

**State and rehydration.** The pane layout keeps only
`TabInfo.graphDesignerData = { selected?: GraphTemplateRef }`
(`pane-layout-restore.ts` restores a shape-checked ref, without importing the
protocol library). Everything else is a backend snapshot held in
`stores/graphDesignerStore.ts`: `libraries: Map<projectId, …>` (from
`graph_templates_list`) and `tabs: Map<tabId, …>` (the template from
`graph_template_get`, its compile result from `graph_template_compile` with
`includePlan: true`, the canvas selection, a focus request counter and the
editor). The tab re-reads both on mount, on `graph-template` resource changes
and on view safety checks; responses for a template the tab no longer shows
are dropped (a per-tab request sequence). Each ref the pane layout names is
acted on once, so a tab that moved on by itself (a save as copy, a new draft)
is not pulled back before the layout catches up.

**Compiling.** A stored template is compiled by the backend, under the
project's capability ceiling, enabled providers and probed host. A draft is
compiled in the browser with the same `compile()` 250 ms after the last edit
(`GRAPH_DRAFT_COMPILE_DELAY_MS`), with the ceiling from the library result and
the enabled providers from settings; the host is the conservative default (no
Claude command sandbox). A backend refresh while editing never replaces the
draft's own compile.

**Panels** (`components/graph-designer/`):

- `GraphLibraryList`: built-in, user ("Yours") and project sections, compile
  counts, the engine a built-in runs on (a retired engine is marked), project
  trust (`trusted`/`untrusted`/`changed`) with Approve (at the digest shown) and
  Revoke, and the project directory's problems.
- `GraphCanvas` and `GraphCanvasNodes`: React Flow, read-only unless editing
  (`nodesDraggable`/`nodesConnectable` false, `elementsSelectable` false with
  selection controlled by the store, `disableKeyboardA11y` with our own keys).
  The projection is `buildGraphCanvasModel({template, plan, diagnostics})`
  (`graph-designer-model.ts`): faces with the title, `{role} · {profile}`, an
  enforcement-floor badge and a replication badge; handles `in:<port>`,
  `out:<port>` and `outlet:<name>` coloured by `graphTypeFamily`; run inputs and
  outputs as `$inputs`/`$outputs` pseudo-nodes; each loop a `graph-loop` group
  ("↻ ≤ N") whose members are children; carries as dashed edges. Positions come
  from `template.layout` when it places every node, else from
  `layoutGraphTemplate` (longest-path layers, one band of rows per loop). Nodes
  and edges with errors are marked (`data-graph-diagnostics="error"`). One tab
  stop (the selected node, else the first); arrows and Home/End move in the
  plan's topological order; Enter or Space selects.
- `GraphInspector`: the template summary, or the selected node (kind, role,
  profile, prompt, ports with render, collect and delivered types, execution
  settings, compiled capabilities and the per-provider enforcement matrix from
  `agentPolicyEnforcementMatrix`), edge (source and delivered types, iterations,
  transforms) or loop (members, entry, `until`, carries).
- `GraphCompilePanel`: counts, the cost estimate (best–worst agent sessions and
  activations, peak parallelism) and every diagnostic; one that names a node,
  edge or loop selects it and brings it into view.
- `GraphImportDialog` (paste or file → `graph_template_import`, with the
  guard's errors on refusal), Export (download) and Copy JSON
  (`graph_template_export`, canonical text), Duplicate (`graph_template_duplicate`;
  a project template passes the digest shown), and `GraphJsonEditor`, the
  draft as JSON while editing (valid text replaces the draft as one undoable
  edit; see Editing).

### Editing (item 212)

**The editor and its history.** "Edit" on a user template (or "Edit as JSON",
which also opens the JSON view) calls `openEditor`; **New graph** calls
`openDraft(tabId, blankGraphTemplate(), projectId)` and clears the pane
layout's ref. The tab's `editor` holds the structured `draft`
(`GraphTemplateV1`), `saved` (the template last loaded or saved; `draft !==
saved` is "unsaved"), `baseRevision`, `isNew`, the `history` and the save
state. Every change is one store call, `edit(tabId, label, recipe, {coalesce})`,
where `recipe` is a pure function over the template (`graph-designer-edits.ts`,
`graph-designer-connect.ts`). The history (`graph-designer-history.ts`) keeps
the previous template per step, at most `GRAPH_DESIGNER_HISTORY_LIMIT` (100)
steps (invariant 6); edits with one coalesce key within 1.5 s (typing in one
field, nudging one node) are one step. Undo and redo are on the editing bar
and on Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z and Ctrl+Y anywhere in the designer except
text fields (which keep their own undo); Ctrl/Cmd+S saves. Leaving unsaved
edits (another template, New graph, Stop editing, Reload latest) asks first. A
new, never-saved draft lives only in the store: a reload drops it.

**Canvas.** `buildGraphCanvasModel({..., editable: true})` always shows the
run inputs and outputs, adds a `+` handle (`in:+`) to every node but
sub-graphs and to the run outputs, and lets loop members leave their frame.
`GraphCanvas` takes a `GraphCanvasEditor` (from `useGraphDesignerEditing`):

- *Palette* (`GraphPalette`, a toolbar on the canvas): Agent, System (a menu of
  the eight actions, labelled, described and marked "side effect" from 207's
  `GRAPH_SYSTEM_ACTION_SPECS`; a new node gets the spec's required inputs and
  the outputs the template can name, `graph-designer-system-actions.ts`),
  Gate, Merge, Human, Loop region (wraps the selected node) and Sub-graph
  (disabled, Phase 4). A node is added at the centre of the view and selected.
  A new agent gets a role of its own name, which follows its first rename.
- *Connecting.* `graphConnectionVerdict(template, library, from, to)` decides
  what a connection becomes, using 102's `graphTypeAssignability` on the
  delivered type (a replicated producer delivers `list<T>`): an `edge`
  (fan-in when a list port collects a replicated producer); a `zip` edge
  between nodes replicated the same way; a loop `carry` when the edge would
  close a cycle inside one loop region (a cycle outside a loop is refused);
  one value into a list port is refused (one → many is `replicate`). While a
  drag is in progress every face reads `useConnection()` and asks for each of
  its handles: compatible handles light up (`data-graph-connect="compatible"`),
  the rest dim and refuse the drop, and a hint says what the drop would do or
  why not. An outlet forwards the gate or human input that fits the target
  port. The `+` handle adds a port of the delivered type (on a merge it also
  sets the output and the dedupe key; on the run outputs it adds a run
  output). A second producer drawn into a loop member's port from outside the
  loop sets `firstIterationFrom`.
- *Fan-in default (D11).* A replicated producer drawn into a single-value port
  of a non-merge node inserts a `dedupe` merge between them when the element
  type declares `items` (key: `file`, `line`, `title` when the items have
  them, else `id`, else the first text field), with a notice and one undo
  step. When the type has no items to dedupe, the port becomes `list<T>` and
  collects the branches instead. Into a merge node's port, the port becomes
  the list. An agent consolidator remains a separate agent node.
- *Moving* writes absolute positions to `template.layout`, for every node at
  once (the layout is honoured only when complete; `materializeGraphLayout`).
  Dropping a node on a loop frame moves it into that loop; dragging a member off
  its frame takes it out, unless it is the loop's only member (the frame
  follows it). **Arrange** lays everything out automatically and keeps it.
- *Deleting:* Delete or Backspace on a focused node or a selected edge, or the
  inspector's Delete; edits keep references consistent (edges, carries, run
  outputs, loop members, `firstIterationFrom`, `session.from`, layout).
- *Keyboard equivalents* (spike notes): C on a focused node, or "Connect to…"
  in its inspector, opens `GraphConnectDialog` (any source, and only the
  targets the same verdict accepts); L, or "Loop…", opens `GraphLoopDialog`
  (move into a loop, wrap in a new one, take out); Shift+arrows move the node
  20 px.
- *Replication* (D9) is the agent's Execution setting; a replicated node draws
  as a stacked card with its "×N" badge.

**Inspector forms** (`GraphInspector` with `editing`, inside
`GraphEditorContext`; controls in `graph-form-controls.tsx`: identifiers and
numbers commit on blur or Enter after validation, free text as typed):

- nothing selected: `GraphTemplateEditor`: id (new drafts only), name,
  description, workspace, limits, parameters (renaming one rewrites `params.*`
  condition paths), roles (multiplicity, panel size, `defaultsFrom` with
  `additionalReviewers` kept last on panel roles; renaming follows the nodes),
  run inputs and outputs, custom types (`GraphTypesEditor`) and the
  acknowledgements on record (stale ones flagged).
- agent (`GraphNodeEditor` with four tabs): Prompt (`GraphPromptEditor`),
  Inputs/Outputs (`GraphPortsEditor`: names, types from the library including
  custom types and list shapes, render modes, collect policy on list inputs,
  `firstIterationFrom` inside loops, provenance, `choices` on decision
  outputs), Capabilities (`GraphCapabilitiesEditor`: profile, workspace
  access, allow/deny per capability with the compiled result, `orkestrator:*`
  opt-ins, a JSON fallback, `minEnforcement` with D4's lowered-floor note and
  Acknowledge, and the per-provider matrix `GraphEnforcementMatrix`),
  Execution (`GraphExecutionEditor`: role or a new one, replicate over a panel,
  lenses with the lens editor and the Settings presets (D19), or samples;
  `items` waits for item 401; session fresh or continue; `ask_human`; retry,
  timeout and on-failure; `when`).
- system, gate, merge, human (`GraphSystemEditor.tsx`, `GraphKindEditors.tsx`,
  `GraphMergeHumanEditors.tsx`): the action from its spec (description,
  idempotency, side effect, the types it reads and produces with the port
  carrying each, the compiler's port diagnostics and "Use default ports") and a
  typed params form (`GraphSystemParamsEditor`: one field per spec parameter
  with its default, range and description; messages from
  `checkGraphSystemParams`, the compiler's `system-param-invalid` ones; JSON
  fallback within the template bounds); gate branches with
  `GraphPredicateEditor` (104's operators, path suggestions from the input
  schemas via `graph-designer-scopes.ts`, live type check, JSON fallback) and
  outlet renames that follow the edges; merge strategy with key, choice and
  score paths; human form (approve, edit with the input to edit, choose with
  options) and timeout.
- edge (`GraphEdgeEditor`: zip, transforms as JSON, delete) and loop
  (`GraphLoopEditor`: label, bound, `until`, members, carries, delete keeping
  the members).

**Prompt editor.** `{{` opens autocompletion of what the node can read
(`graph-designer-prompt.ts`): `> input.<port>` partials, `input.<port>` and
its schema fields, `params.*`, `run.iteration`, `lens.*` and `branch.*` on
replicated nodes, `ticket.*`. The preview is 105's `renderGraphNodePrompt`
(the executor's function) with `preview: true`, over each input type's
`example` (`graphNodePromptPreviewValues`) or a pasted fixture (keys are input
ports, plus `params` and `ticket`): the user part and, below it, the locked
system contract. Size is 105's estimate against the 160 KiB input ceiling,
with fan-in list sizes from the producers' branches. Lints and render problems
are listed inline; one with an offset links to its line and column.

**Type editor.** `GraphTypesEditor` and `GraphSchemaEditor` (forms limited to
102's subset: object roots, every property required with "may be null" as
`anyOf` with null, closed objects, enums, bounds, arrays and nested objects,
`x-orkestrator-sources` on string arrays), JSON fallback, "Schema from example"
(`draftGraphSchemaFromExample`), and live checks (`checkArtifactTypeDef`, the
subset checker, the example against the schema). Renaming a type or changing
its version rewrites every port that names it.

**Acknowledgements.** The compile panel lists `pendingAcknowledgements` (taint
reaching a side effect, §5.13; a lowered floor, D4) with an Acknowledge action;
it records `{kind, digest, acknowledgedAt, code}` in the draft
(`acknowledgeGraphWarning`), so the next compile reports the warning as
accepted. A change that alters the warning changes its digest and needs a new
acknowledgement; stale ones are flagged in the template form.

**Saving.** `saveDraft` refuses a draft the template guard refuses (listing
the errors), then calls `graph_template_save` with `expectedRevision` = the
base revision (0 for a new template). A `revision-conflict` keeps the draft and
offers **Save as copy** (`saveDraftAsCopy`: `graph_template_import` of the
draft as `<id>-copy` and "<name> (copy)", which picks a free id) and **Reload
latest**. When the stored template moves on while editing (a `graph-template`
change), the bar says so before Save is tried. After a save the editor
continues on the stored template, history kept.

**Tests.** Component and store tests next to the code (happy-dom with the
React Flow stubs in `react-flow.test-support.ts`, and `renderWithGraphEditor`
in `graph-editor.test-support.tsx` for the forms; a drag in happy-dom must not
be wrapped in `act()`, because React Flow auto-pans with an animation-frame
loop while connecting). The real-stack paths are
`e2e/agent-testing/graph-designer.spec.ts` (110) and
`graph-designer-editing.spec.ts` (212: the design bake-off built from a blank
canvas, taint acknowledged, compiled clean, saved, rehydrated after a reload,
and a lost save race saved as a copy), both in the browser suite.

## Mock runs (item 213)

A mock run tests a graph's control flow for free (report §7.5): it runs on the
same scheduler as a real run (admission, retries, `onFailure`, loops, the
record's bounds; gates and merges are the live executors), but its agent,
system and human nodes are answered by mock executors registered with
`{ mock: true }`, and the registry never lets a mock run fall back to a live
`agent` or `system` executor. `GraphRun.mock` is true and
`GraphRun.mockOptions` freezes the effective pins and step delay.

**Answers.** Each output port of an agent or system node takes, in order: the
activation's pin, else the type's `example`, else a value generated from its
schema (`graphSchemaSample`, deterministic over the 102 subset: `const`, then
`enum`, the first non-null `anyOf` branch, every object property, one array
element, name-driven strings so format checks pass, `minimum` or 1, `true`).
`graphMockValue` fits built-in values to the port (a decision's `choices`, the
ticket input's criterion ids for a verdict, the run's commit for `headRef`)
and checks them with `validateGraphArtifactValue`; a generated value that
fails falls back to the example. Values are stored through the artifact store,
so they pass the same validation as real ones; a pinned value that does not
fails the activation with `invalid-result`.

- *Agents* create no session and report no tokens, policy, baseline or guard
  result: guards are no-ops on mock nodes. A writing agent's `workspace@1`
  output is a fake commit, `graphMockWorkspace` (a deterministic SHA from the
  run, activation and port on top of the input commit; nothing touches git).
  A mock agent never asks a question.
- *System nodes* never run an action handler. `workspace@1` passes the input
  commit through, `review-package@2` is an unwritten mock file
  (`GraphArtifactStore.putMockReference`, which `verify` accepts for mock
  runs only), `pr-result@1` says no pull request was opened, and
  `wait-for-checks` answers its pinned or example `check-summary@1` at once.
  An action with `sideEffect` records "would have run" in the effect journal:
  state `simulated`, key `would-run:<activation key>`, data
  `{ wouldRun: GraphMockWouldRun }` (action, label, a one-line summary, the
  parameters with defaults, facts such as branch, commit, target branch,
  ticket move or recipient, and the input and output artifact ids).
  `graph_run_effects {runId}` lists a run's effect rows.
- *Human nodes* answer by themselves (approve; an `edit` form forwards the
  value unedited; a `choose` form takes its first option), so a mock run
  completes unattended. A pin takes another outlet (`{outlet, outputs?}`, the
  edited value of an `edit` form) or `pause`s: the activation is handed to
  the live human executor (item 208) and waits for a person; a launch with a
  `pause` pin is refused while no human executor is registered.

**Pins** (`GraphMockPins`: node id → sequence). The *n*-th activation of a
node's branch (retries, iterations and restarts counted in record order)
takes the *n*-th pin; the last repeats. A pin is `"example"`, `"generated"`,
`{outputs: {port: value | null}}` (custom JSON; `null` leaves an optional port
unproduced), `{fail: cause, message?}`, or, for human nodes, `{outlet,
outputs?}` and `"pause"`. Gates and merges take none. Pins are stored on the
template (`mockPins`, designer data outside the digest, like `layout`) and a
launch's `pins` replace them node by node; `graphMockPinIssues` checks them
against the ports (codes `mock-pin-unknown-node`, `mock-pin-node-kind`,
`mock-pin-form`, `mock-pin-unknown-port`, `mock-pin-required-port`,
`mock-pin-value`, `mock-pin-outlet`). "Verify: fail, fail, pass" is three
custom verdicts on `verify`; the loop converges on iteration 3.

**Launching** (`graph_run_mock {ref, projectId, environmentId?, inputs?,
params?, roles?, pins?, panel?, stepMs?}`, `GraphMockRuns.launch`). The
stored template is compiled under the project's ceiling; compile errors and
built-ins (`engine`, duplicate first) are refused, but trust and pending
acknowledgements are not needed (nothing runs). Unbound roles get
placeholders (`claude`, model `mock`; panel roles `panel` of them, default
2), missing run inputs their type's example. Without `environmentId` the run
is environment-less: it never provisions an environment and starts
`running`; executors see `environmentId: ""`. With one, it is listed and
removed with that environment, and still touches nothing. A mock run holds no
workspace locks (`graphRunLockedWorkspace`), so it never blocks a real run.
`stepMs` (0–10,000) makes each mock activation report `running` for that long
first, so the run view shows it moving. Retention: each environment-less
launch keeps the newest 20 finished environment-less mock runs of the
project (`deleteEnvironmentlessGraphRun`); a deleted project's are cancelled
or deleted, and orphans are swept at startup. `usage.agentSessions` still
counts admitted agent activations (the run's budget), not provider sessions.

**Designer.** The header's **Mock run** button saves an unsaved or new draft
first, launches the stored template with `stepMs` 1,000 and calls
`requestGraphRunView({runId, projectId, environmentId, mock: true})`
(`lib/graph-run-navigation.ts`); the run view (item 211) registers
`onGraphRunViewRequested` and reads `takePendingGraphRunView()` when it
mounts. Built-ins are disabled until duplicated. In the inspector, agent nodes
have a **Mock run** tab and system and human nodes a **Mock run** section:
the pinned-sequence editor (`GraphMockPinsEditor`), a list of runs, each one
of example, generated (with a preview), custom JSON (starting from the
examples), fail (with a cause) or, for human nodes, an outlet or a pause;
`graphMockPinIssues` messages show under each run. Renaming or deleting a node
moves or drops its pins.

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
