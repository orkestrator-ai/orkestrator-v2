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
| Guards and enforcement (209) | `agent-enforcement.ts`; backend `graph-agent-guards.ts`, `graph-agent-policy.ts` | Each agent node's tier per provider and host, the launch pickers' choices per role, and the post-hoc guards around every activation (below). |
| Designer (110, 212) | `apps/web/src/components/graph-designer/`, `apps/web/src/stores/graphDesignerStore.ts` | The Graphs designer tab: library, canvas, inspector and compile panel; user templates and new graphs are edited on the canvas (below). |
| Run view (211) | `run-view.ts`; backend `commands-registry-graph-runs.ts`, `graph-run-user-actions.ts`, `graph-run-transcripts.ts`; web `components/graph-run/`, `stores/graphRunStore.ts`, `lib/backend/graph-runs.ts` | The `graph-run` tab: a run on the shared flow graph with an inspector and controls, rehydrated from revisioned snapshots (below). |

## Guards and enforcement (item 209)

What a capability profile promises is either enforced by the provider or
detected by a guard, and the activation records which (plan P2.9, D4, D12).

- **The tier.** `graphAgentNodeEnforcement(compiled, platform, host)` judges a
  node on a provider and host with the shared matrix (106), including the one
  exception: a Claude `researcher` runs as an ordinary turn so hosted search
  stays available, at most `provider-configured`. The launch compile
  (`graph_template_compile` with `forLaunch`, or `compileForLaunch`) re-probes
  the host and returns `providerChoices`: per role, every enabled provider's
  weakest tier over the role's nodes and whether it meets each node's
  `minEnforcement` (`graphRoleProviderChoices`). The launch pickers offer the
  `allowed` ones; `graphBindingFloorProblems` lists bound models that miss a
  floor.
- **At dispatch** the executor judges the node again on the live host
  (`defaultCoordinatorHostCapabilities`, whose Linux sandbox probe is
  re-run after its TTL). A tier that dropped since launch fails the
  activation before any session with `guard-violation` and a message naming
  the provider, tier, floor and reason. The applied tier, its reason and an
  `enforcement` guard result are recorded on the activation.
- **Read-only guard** (`read` and `none` nodes): the generic guard from item
  001. The baseline (HEAD, the uncommitted path set: its digest and count, the
  paths themselves when at most 64) is captured before dispatch and fails
  closed. An acceptance check on `graph-output` slots, scoped to the
  activation's own result keys, refuses a submission with a correctable
  `worktree_changed` error so the agent can put the tree back in its turn.
  When the result is consumed, before any artifact is stored, the worktree is
  certified again; a change fails the activation and the evidence (message,
  paths) stays in its `guards`.
- **Remote-ref guard** (every agent node; none may push): before dispatch the
  run branch is read with `git ls-remote` on `origin` and the branch's
  upstream remote (every remote when neither exists); unreachable remotes fail
  closed. After the turn their heads and tags are listed again. The guard
  fails the activation when the run branch moved or any ref points at a
  commit the activation created (in `baseline..HEAD` or the worktree's HEAD
  reflog since the capture, committed after it). Commits the run's own
  `push-branch` or `open-pull-request` pushed are not counted. It cannot see a
  push to an unwatched remote or URL, a push of older commits, or GitHub
  writes that are not pushes.
- **GitHub credential.** Graph agent policies deny `github.write`; the Claude
  and Grok bridges then start the session without the GitHub credential
  (see [agent engines](agent-engines.md)). Codex, OpenCode, Cursor and Pi do
  not withhold it yet, and a container's runtime credential stays readable.
- **The inspector** reads `activation.enforcement`, `enforcementReason` and
  `guards` (`graphActivationEnforcementView` labels them).

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

## The run view (item 211)

**Opening it.** A `graph-run` tab shows one run ("Graph run", or the run's
name, in the tab chrome; D17). The designer lists the environment's runs under
its library (`GraphRunsList`); a row calls
`createTab("graph-run", { graphRun: { runId, title } })`, and there is one tab
per run (`openGraphRunTab`, `components/graph-run/graph-run-open-tab.ts`).
Item 214 adds the launch entry points. The pane layout keeps only
`TabInfo.graphRunData = { runId, title? }`; the component is lazy-loaded from
`PaneLeafContainer`.

**Reads and rehydration.** The view reads only snapshots (invariant 1). The
commands, with shapes in `@orkestrator/protocol/graphs/run-view`:

| Command | Arguments | Result |
| --- | --- | --- |
| `graph_runs_list` | `{environmentId}` | `GraphRunSummary[]`, newest first, at most 200 |
| `graph_run_get` | `{runId, knownRevision?}` | `{status: "changed", run}` or `{status: "unchanged", revision}` |
| `graph_run_cancel`, `graph_run_pause`, `graph_run_resume` | `{runId}` | `{status: "changed", run}` |
| `graph_run_retry`, `graph_run_skip` | `{runId, activationKey}` | `{status: "changed", run}` |
| `graph_run_artifact` | `{runId, artifactId}` | the envelope; the value inline up to 512 KiB (else `valueOmitted: "too-large"`); a reference artifact's file metadata and descriptor, never the file |
| `graph_run_transcript` | `{runId, activationKey, fromIndex?, maxBytes?}` | one window (default 2 MiB, at most 4 MiB) of the activation's stored transcript, or `none` |
| `graph_run_answer` | item 204: `{runId, activationKey, questionId, kind, text?, choice?}`; item 208: `{runId, activationKey, waitId, decision, outlet?, value?, note?}` | answers an agent's `ask_human` question (`{activationKey, question}`) or a waiting human node (`{activationKey, human}`) |
| `graph_run_pending` | `{runId}` or `{environmentId}` | `GraphRunPendingInteraction[]`: every open human wait and `ask_human` question of the run (or of the environment's live runs), derived from the stored record |

Refusals throw `GraphRunServiceError` (`invalid-request`, `not-found`,
`invalid-state`, `disabled`). Snapshots go through `graphRunViewSnapshot`,
which drops the runtime's own repair and continuation prompts.
`stores/graphRunStore.ts` re-reads a run on mount, when the tab becomes active,
on `graph-run` resource changes naming it, on resource resyncs and on view
safety checks (the gap path), passing the revision it holds; it applies a
snapshot only when its revision is newer, coalesces a burst of change events
into one read in flight plus one after it, keeps the last snapshot when a
refresh fails, and shows a deleted run as gone. Unmounting or closing the tab
sends nothing. Artifacts (newest 200) and transcripts (newest 32 activations)
are cached with bounds.

**Projection.** `graphRunFlowModel(plan, run, {expandedAttempts?})`
(`components/graph-run/graph-run-flow.ts`) feeds the shared `FlowGraph` (D16)
through `GraphRunFlowGraph`, with the build pipeline's column layout. A flow
node is a node position (plan node, loop iteration, branch; id
`node#iter=N[#branch=K]`), the run's inputs, or a previous attempt. Columns are
the longest path over the positions: the branches of a replicated node share a
column, and each loop iteration unrolls to the right of the last (a carry feeds
the next iteration; the next iteration is drawn once entered). Positions not
reached are faded (`placeholder`), "ahead" while the run is live and "not
reached" after it ended. A gate or human node shows the outlet it took, edges
out of the other outlets stay pending (`untaken`), and nodes behind them show
as skipped. An `awaiting-human` activation is highlighted "waiting for you",
the run header shows a banner, and the node is selected by default.
Activations a rewind superseded collapse into one "Previous attempt" node per
rewind, in the column of the node it restarted; expanded (the flow view
store's `expandedAttempts`), its activations follow in their own columns,
greyed. Retries stay on one position; the face shows the newest attempt and
the inspector can show the earlier ones.

**Inspector** (`GraphRunInspector`): Details and Transcript views. Details
holds the agent's `ask_human` question with `GraphQuestionAnswerForm` (choices,
free text, decline), the human node's `GraphHumanNodePanel` (item 208; see
"Human nodes"),
the error and its cause, the profile, the enforcement tier actually applied and
`enforcementReason`, the sandbox policy and turn mode, guard results with their
paths, the session's agent, tokens and times, provisional `report_progress`
items, and the output and input artifacts (`GraphArtifactCard`), rendered by
type: a built-in formatter (a review report in the review view), else the
type's markdown template, else its summary fields, else JSON. The Transcript
view (`GraphActivationTranscript`) renders an agent activation's stored
transcript with the build pipeline's stage-transcript stack
(`toPipelineTranscript`, `VirtualizedMessageList`, `NativeMessage`).

**Transcripts.** The agent executor's `captureTranscript` dependency
(`graph-run-transcripts.ts`, wired in `index.ts`) stores each activation's
provider messages in the build pipeline's content-addressed transcript store,
owner `graph-run:<run id>`, one session per activation key, and records the
`PipelineTranscriptReference` on the activation's session. It captures when a
turn settles and at most every 15 s while it runs, only when the content
changed, and never fails an activation. The manifest commits before the run
record names it; the orphan sweep counts existing graph runs as live owners,
and deleting a run with its environment deletes its transcripts.

**Actions** (`graph-run-actions.ts`, the same list on the faces' context menus
and in the inspector): Retry (a failed position of a live run, as a new
attempt; `graph_run_retry` records a user `restart` rewind over the lineage
descendants and the never-started markers derived from the failure), Restart
from here and Rewind code to here… (item 210's wrappers in
`lib/backend/graph-run-rewind.ts`, behind `GraphRunRewindBackend` in
`lib/backend/graph-runs.ts`; offered by 210's `graphRunRestartBlocker`, and
Rewind code to here stays listed but disabled with `graphRunCodeRewindBlocker`'s
reason, such as "Pause the run first", when only the code rewind is refused;
the rewind opens a preview dialog and confirms with the HEAD it showed), Skip (a `waiting` or
`ready` position, held back by a pause, a workspace lock or the run's limits),
Open session (the agent's provider session in a native tab that refuses to
start a fresh one), and the run-wide Pause, Resume and Cancel (with a
confirmation). Mock runs are labelled "Mock run" in the header and "mock" in
the list.

## Human nodes (item 208)

A person takes part in a run at an explicit point (P2.8, D15, report §6.8).
Shapes and validation are in `@orkestrator/protocol/graphs/run`
(`run-human.ts`); the executor and the answers are in
`apps/backend/src/core/graph-node-human.ts`.

**Forms.** `approve` takes `approved` or `rejected`; `edit` does the same, and
an approval may carry an edited value of the form's `edit` input; `choose`
takes one option's outlet. A decided node forwards its single-value inputs as
its outputs, as a gate does, with an edited value in place of the original.

**The wait.** The executor's first call records `activation.human`
(`GraphHumanWait {id, form, openedAt, answer?}`, a fresh UUID) and reports the
activation `awaiting-human`; the pass then makes the run `waiting` when nothing
else is admitted. The executor is observed only when woken
(`observeAfterMs: null`), or at the node's deadline. The wait is in the run
record, so it survives a backend restart (recovery observes it) and any view
rehydrates it. A restart of the node (item 210) supersedes the activation; its
wait dies with it.

**Answers.** `graph_run_answer` with a `waitId` goes to `GraphHumanAnswers`,
which checks `graphHumanAnswerProblem` (the activation waits, the wait id is
this attempt's, it is unanswered, the decision fits the form, the note and an
edited value are within bounds), stores an edited value as a new artifact of
the original's type (validated against it, with the producing port's `choices`
for `decision@1`; lineage: the original; producer: the human activation on the
edited port; an unchanged value stores nothing), then records the answer under
the run's lock through `GraphRunService.updateActivation`, checking again, which
wakes the run to observe the activation. A refused answer records nothing
(invariant 10). `ask_human` answers share the command and the locked update.

**Timeouts.** Without `timeoutMs` the run waits indefinitely, paused rather
than failed. With one, a human node's default `onFailure` is `route`
(`graphHumanRoutesFailures`), which gives it an implicit `error` port carrying
`error@1` (`GRAPH_HUMAN_ERROR_PORT`; edges read it as `{node, port: "error"}`
without an outlet, and the designer draws it as an output). The timeout
arrives as `cancel(…, "timeout")`; the pass fails the activation with cause
`timeout`, the planner routes `error@1`, and the outlets' consumers are
skipped. An answer recorded before the deadline still wins. `onFailure:
fail-run` opts out of the route.

**Where a wait shows.**

- The run view: the face reads "waiting for you" and the inspector's
  `GraphHumanNodePanel` renders the shared `GraphQuestionAnswerForm` (choices
  Approve/Reject or the options, an optional note, no decline) and, for `edit`,
  `GraphArtifactValueEditor`: the type's form for a flat object schema
  (strings, enums, numbers, booleans, lists of strings, optionally nullable),
  else JSON, checked live with `validateGraphArtifactValue`.
- The sidebar (`graph-run-attention.ts`): the environment's `graph-run`
  activity source is `working`, `waiting` or `idle`
  (`graphRunEnvironmentActivity`), and each new wait (human wait or question
  id) records one content-free attention key (`graph-run:<sha256>`), which
  lights the unread badge with reason `agent_question` once. It runs on
  `graph-run` changes (debounced per run) and reconciles every environment at
  start. `GraphRunAttention.onWaitOpened` reports each wait the first time it
  is recorded.
- The coordinator (`graph-run-coordinator-status.ts`, observed by
  `coordinator-status-wakes.ts` for `graph-run` associations): one notice per
  wait (the key names the newest open wait and when it opened; a wait is news
  only when it opened after the last one reported), and one when the run
  completes, fails or is cancelled. Item 214 records the association when the
  coordinator launches a run.

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
