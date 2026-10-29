---
id: 212
title: "Editable designer"
phase: 2
plan: "P2.12"
status: done
depends_on: [107, 109, 110]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1436"
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

- [x] Canvas: add, connect, delete and group (loop regions), with undo. Dragging from a port shows only compatible targets.
- [x] Replication is a node setting drawn as a stacked "×N" card (D9). A new fan-in defaults to a `dedupe` merge (D11).
- [x] Inspector forms: prompt; inputs and outputs; capabilities (profile, toggles, the per-provider tier matrix, `minEnforcement`); execution (role, replicate, retry, timeout, failure, session).
- [x] Prompt editor: variable autocomplete from input schemas; live preview with the system contract, using type examples or a pasted fixture; size against the ceiling; lints.
- [x] Type editor limited to the schema subset, plus "schema from example".
- [x] Live compile panel and cost estimate. Saving uses compare-and-swap; a conflict offers "save as copy".
- [x] Taint warnings need an acknowledgement, stored in the template against the warning's digest.

## Tests

- [x] Component tests for each editor.
- [x] Agent-testing run: build the design bake-off graph (report §9.3) from scratch and compile it clean.

## Done when

- [x] A user can build, validate and save the report §9 examples on the canvas.

## Notes

**2026-10-29 · Files and APIs.** Web only; nothing in the backend or protocol changed.
`apps/web/src/components/graph-designer/`: pure edits `graph-designer-edits.ts`
(`blankGraphTemplate`, `addGraphNode`, `removeGraphNode`, `renameGraphNode`, port and run-input
renames/removals, `moveGraphNodes`/`materializeGraphLayout`/`arrangeGraphLayout`, loop ops
`createGraphLoop`/`addGraphNodeToLoop`/`removeGraphNodeFromLoop`/`removeGraphLoop`,
`acknowledgeGraphWarning`, `mapGraphPredicatePaths`), connections `graph-designer-connect.ts`
(`graphConnectionVerdict(template, library, from, to)` → plan `edge | carry | fan-in-merge |
fan-in-list | new-input | run-output`, `applyGraphConnection`, `GRAPH_NEW_PORT_HANDLE = "in:+"`,
`defaultGraphDedupeKey`), history `graph-designer-history.ts` (`GRAPH_DESIGNER_HISTORY_LIMIT` 100,
coalescing 1.5 s), `graph-designer-system-actions.ts` (catalogue: label, default ports, known params),
`graph-designer-prompt.ts` (prompt context with fan-in list sizes, `{{` completion),
`graph-designer-scopes.ts` (predicate scopes and path suggestions, outlet renames),
`graph-designer-types.ts` (custom-type helpers, `renameGraphTypeRef`), `graph-editor-context.ts`
(`GraphEditorContext`, `useGraphEditor`, `useGraphNodeEdit`), `graph-form-controls.tsx`,
`useGraphDesignerEditing.ts`; components `GraphPalette`, `GraphCommandDialogs` (Connect to…,
Move into loop), `GraphEditorToolbar`, `GraphNodeEditor`, `GraphPortsEditor`, `GraphPromptEditor`,
`GraphCapabilitiesEditor`, `GraphEnforcementMatrix` (shared with the read-only inspector),
`GraphExecutionEditor`, `GraphKindEditors` + `GraphMergeHumanEditors` + `GraphNodeExecutionFields` +
`GraphSystemParamsEditor`, `GraphPredicateEditor`, `GraphTemplateEditor`, `GraphTypeEditor` +
`GraphSchemaEditor`, `GraphStructureEditors` (edge, loop). Changed: `GraphCanvas` (`editor?:
GraphCanvasEditor`), `GraphCanvasNodes` (`GraphCanvasConnectContext`, stacked replicated card),
`graph-designer-model.ts` (`editable`), `graph-designer-layout.ts` (`alwaysIo`), `GraphInspector`
(`editing`), `GraphCompilePanel` (`onAcknowledge`), `GraphJsonEditor` (a JSON view of the draft),
`GraphDesignerTab`. Store `graphDesignerStore.ts`: `editor = {draft, saved, baseRevision, isNew,
history, saving, error, saveErrors, conflict}`; actions `openEditor`, `openDraft(tabId, template,
projectId)`, `closeEditor`, `edit(tabId, label, recipe, {coalesce})`, `undo`, `redo`,
`compileDraft`, `saveDraft` (→ detail or null), `saveDraftAsCopy`, `reloadDraft`, `acknowledge`;
`graphDraftDirty(editor)`. `editDraft(text)` is gone (the draft is structured).

**2026-10-29 · Decisions.**
- *D11 default.* A replicated producer drawn into a single-value port of a non-merge node inserts a
  `dedupe` merge (`<producer>-dedupe`, input `sources: list<T>`, output named like the producer's port,
  key `file`/`line`/`title` when the items have them, else `id`, else the first text field) when the
  element type declares `items`; otherwise the port becomes `list<T>` (dedupe needs items). Into a
  merge, the merge's port becomes the list. One undo step, with a notice.
- *Cycles.* An edge that would close a cycle inside one loop region becomes that loop's carry; outside
  a loop it is refused. A second producer drawn into a loop member's port from outside the loop sets
  `firstIterationFrom` (report §9.2).
- *`+` handles.* Every node but sub-graphs, and the run outputs, has an `in:+` handle that adds a port
  of the delivered type; a merge fed this way also gets its output and dedupe key. An outlet into
  `+` works only when the node has one input (otherwise the target port decides which input it forwards).
- *Loops by drag.* Dropping a node on a frame moves it in; dragging a member off its frame takes it
  out, except a loop's only member (the frame follows it). New loops wrap the selected node, bounded
  at 3 with `until: run.iteration ≥ 3` for the user to replace.
- *Roles.* A new agent gets a role of its own name; renaming the node renames that role while no other
  node uses it.
- *Layout.* Every edit that moves or adds writes the whole layout (the canvas honours only a complete
  one); Arrange rewrites it from the automatic layout.
- *Keyboard.* C (Connect to…), L (loop), Delete, Shift+arrows on a focused node; undo/redo/save on the
  window while the designer is active, except in text fields (React Flow's own keys stay off).
- *System params.* 207 had not landed a per-action param schema: the editor is generic (scalar or list
  values within the template bounds, the `record` key the built-ins use, JSON fallback); when 207
  exports per-action rules, plug them into `GRAPH_SYSTEM_ACTION_CATALOGUE[action].params`.
- *Save as copy* uses `graph_template_import` (it picks a free id) with `<id>-copy` / "<name> (copy)".
  The browser gateway's HTTP response carries `code: "revision-conflict"` (seen in the real stack);
  `isGraphRevisionConflict` accepts the code or the backend's message, so either path works.
- *Drafts* are client-only: a reload drops a new, unsaved draft (the pane layout keeps refs only).
- *Phase 4 parts.* Sub-graph is shown disabled in the palette ("Phase 4", item 402); replicate over
  `items` is disabled in the Execution form (item 401). So "the report §9 examples" means §9.3 without
  the sub-graph and §9.4 with a static panel, as the Phase 2 exit criteria say. Evidence: §9.3 built from
  a blank canvas in the agent-testing run; §9.2's loop (carries, `firstIterationFrom`) built with the
  same operations in `graph-designer-connect.test.ts`; §9.1's parts (panel replication, consolidation,
  gates with outlets, system PR node) are covered by the form and connection tests.

**2026-10-29 · Tests and evidence.** Component and store tests (happy-dom): `graph-designer-edits.test.ts`,
`graph-designer-connect.test.ts`, `graph-designer-scopes.test.ts`, `graph-designer-types.test.ts`,
`GraphCanvas.test.tsx` (editable: drag lights only compatible handles, keyboard Delete/C/L/Shift+arrows,
palette, stacked card), `GraphDesignerEditing.test.tsx` (new graph, palette, undo/redo by toolbar and
keyboard, discard confirmation, Connect to… dialog, taint acknowledgement, save CAS, conflict → save as
copy), `GraphNodeEditor.test.tsx`, `GraphPromptEditor.test.tsx`, `GraphPredicateEditor.test.tsx`,
`GraphKindEditors.test.tsx`, `GraphTypeEditor.test.tsx`, `GraphTemplateEditor.test.tsx` (template,
edge, loop, compile-panel acknowledgements), `stores/graphDesignerStore.test.ts`. Real stack:
`e2e/agent-testing/graph-designer-editing.spec.ts` (browser suite) against an isolated
`dev:test --fixture --no-agent-credentials` profile `graphs-212`: New graph, run inputs, `design-brief@1`
from its example, Design (×3 lenses, researcher) with a drag from the run input onto "+ input" (only
compatible handles lit, hint shown), Judge (fan-in list, decision choices, cited brief), Approve (edit),
Build, Describe PR, open-pull-request and the run output via "Connect to…", undo/redo by keyboard,
Arrange, two taint warnings acknowledged, 0 errors, saved (layout, roles and acknowledgements stored),
reload rehydrates it with a clean backend compile, then a save that lost a race offers Save as copy and
saves `qa-bake-off-copy`. `graph-designer.spec.ts` (110) still passes. Screenshots under
`output/agent-testing/graphs-212/browser/artifacts/` (not committed).

**2026-10-29 · For 213, 214 and 215.**
- 213 ("Mock run"), 214 ("Run"): add the buttons to `GraphDesignerTab`'s header (beside Duplicate) or
  `GraphEditorToolbar`. Launch only a stored template: when `view.editor` is dirty
  (`graphDraftDirty(editor)`) or `isNew`, save first (`saveDraft(tabId)` returns the detail or null).
  The ref is `view.selected`; launchability is `view.compile.launchable` (pending acknowledgements are
  listed by the compile panel; for a stored template compile by the backend with `forLaunch`).
- 215: open the designer (`openGraphDesignerTab`), then call
  `useGraphDesignerStore.getState().openDraft(tabId, template, projectId)`; it shows the template as a
  new unsaved draft (revision reset to 0, `engine` dropped) and the pane-layout effect does not reload
  over it. Save creates it; a taken id surfaces as a conflict with Save as copy.

**2026-10-29 · System nodes use 207's specs (on `graphs-integration`).** The designer's own
`GRAPH_SYSTEM_ACTION_CATALOGUE` is gone; `GRAPH_SYSTEM_ACTION_SPECS` (protocol
`./graphs/system-actions`) is the single source for the palette's System submenu (label,
description, a `side effect` badge), the system node form and a new node's ports.
`graph-designer-system-actions.ts` keeps only presentation: `graphSystemPortName(type)` (the
built-ins' port names, since specs bind ports by type), `graphSystemDefaultPorts(action, library)`
(required inputs, plus every output whose type the template can resolve, so
`pull-request-state@1` is left out until the template declares it) and the default/bounds hint
labels. `GraphSystemEditor` moved to its own file (re-exported from `GraphKindEditors`): it shows
the spec's description, idempotency and side effect, lists the types the action reads and
produces with the port carrying each (`Add input|output <type>` for a missing one), shows the
compiler's `system-port-unsupported`/`system-input-missing` messages for the node and then offers
"Use default ports"; changing the action drops params the new one does not take.
`GraphSystemParamsEditor` is a typed form per spec param (boolean and enum selects with
"Default (…)"/"Not set", integer with placeholder default and range, branch/id commit fields,
free text as typed, a text area for long text); clearing a field drops the key. Messages are
`checkGraphSystemParams`'s, i.e. exactly the compiler's `system-param-invalid` messages, with the
issue code (`detail`) on `data-graph-param-issue`: fields refuse type/range/format errors
(`graphSystemParamValueIssue`), stored required/conflict/unknown issues show under their field or
at the top; unknown keys are listed with a remove button. The JSON fallback stays (template
bounds) and lists the same issues. System node faces carry `data.sideEffect` and a side-effect
badge (`SideEffectBadge` in `graph-form-controls.tsx`). There is no list param type: 207's
params are scalars only, so the form has no list control (the JSON fallback still accepts what
the template schema allows, and the checker reports it). Tests: `GraphSystemParamsEditor.test.tsx`,
`GraphPalette.test.tsx`, system cases in `GraphKindEditors.test.tsx` and
`graph-designer-model.test.ts`.

**2026-10-29 · Item 401.** Replicate over `items` is enabled in the Execution form: the input port
(list ports and ports of a type that declares items), the most branches and the truncation policy
(`GraphExecutionEditor.tsx`, `GraphItemsEditor.test.tsx`); the prompt editor suggests `item.index`
and `item.id`.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 · Editable designer: canvas editing with palette, typed connections (compatible targets only, D11 dedupe default, carries), loops, bounded undo, keyboard commands; inspector forms, prompt and type editors; live compile with taint acknowledgements; CAS save with save-as-copy; component, store and Playwright tests; docs; complete; awaiting PR.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Designer uses 207's system action specs: palette, typed params form, spec ports, side-effect badges; catalogue removed. · complete; awaiting PR
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Item 401: replicate over items enabled in the Execution form. · complete; awaiting PR
- 2026-10-29 · coordinator · Delivered in https://github.com/orkestrator-ai/orkestrator-v2/pull/1436; status done. · None.
