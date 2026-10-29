# Graphs

Status: Living. Describes the composable-graphs feature as built: Phases 0–2 of
[`plans/composable-graphs.md`](../../plans/composable-graphs.md) and Phase 4
items 401–405. The plan holds the decisions (D1–D21); the work items in
[`plans/graphs/`](../../plans/graphs/000-index.md) hold the record of the work.
The user-facing walkthrough is [graphs-user-guide.md](graphs-user-guide.md).

## Overview

A **graph** is a typed workflow template: nodes (agent, system, gate, merge,
human, sub-graph) joined by edges that carry typed, immutable artifacts, with
bounded loop regions. The UI calls the feature "Graphs" (D17). A template is
compiled into a frozen plan; a **run** executes that plan in one environment
(D7) on the backend's keyed supervisor, and the run record plus its artifacts
are the authority every surface reads.

Multi Review, the Build Pipeline and Looped Review are described as built-in
templates but run on their own engines (D5); Looped Review's engine is retired.
A duplicate of a built-in, or a built-in used as a sub-graph, runs on the graph
runtime. Item 301 (Multi Review on the graph runtime behind a setting) is not
part of this tree yet; see [its placeholder](#multi-review-on-the-graph-runtime-item-301).

Shared contracts are browser-safe modules under `packages/protocol/src/graphs/`
(one `exports` entry each, `@orkestrator/protocol/graphs/<module>`); backend
logic is in `apps/backend/src/core/graph-*.ts`; the UI in
`apps/web/src/components/graph-designer/`, `graph-run/` and `graph-launch/`.

| Part | Protocol | Backend | Web |
| --- | --- | --- | --- |
| Template schema (101) | `template.ts`, `template-model.ts`, `template-nodes.ts`, `grammar.ts` | | |
| Types (102) | `types.ts`, `artifact-type-def.ts`, `schema-subset.ts`, `type-assignability.ts`, `type-validators.ts`, `schema-from-example.ts` | | |
| Result kinds (103) | `output-slots.ts`, `provenance.ts` | `workflow-result-registry.ts`, `workflow-result-graph-output.ts` | |
| Predicates (104) | `predicates.ts`, `predicate-shape.ts`, `predicate-typecheck.ts`, `predicate-eval.ts` | | |
| Prompts (105) | `prompts.ts`, `prompt-*.ts`, `system-contract.ts` | `graph-agent-prompt.ts`, `graph-agent-builtins.ts` | |
| Capabilities (106, 209, 404) | `capability-profiles.ts`, `capability-enforcement.ts`, `agent-enforcement.ts` | `graph-agent-policy.ts`, `graph-agent-guards.ts` | |
| Compiler (107) | `compile.ts`, `compile-*.ts`, `plan.ts`, `cost.ts`, `lint.ts` | | |
| Built-ins (108) | `builtins/`, `builtin-registry.ts`, `examples.ts` | `graph-builtin-templates.test.ts` | |
| Library, trust, sharing (109, 405) | `library.ts`, `sharing.ts` | `graph-template-service.ts`, `storage-graph-templates.ts`, `graph-project-templates.ts`, `graph-template-sharing.ts`, `graph-template-signing.ts`, `commands-registry-graphs.ts`, `commands-registry-graph-sharing.ts` | `lib/backend/graph-templates.ts`, `lib/backend/graph-template-sharing.ts` |
| Run record (201) | `run.ts`, `run-model.ts`, `run-identity.ts`, `run-guards.ts`, `run-lineage.ts`, `run-items.ts` | `storage-graph-runs.ts`, `graph-artifacts.ts`, `storage-graph-effects.ts` | |
| Runtime (202–207) | `run-branches.ts`, `run-fanout.ts`, `system-actions.ts`, `run-agent-session.ts` | `graph-run-service.ts`, `graph-run-supervisor.ts`, `graph-run-pass.ts`, `graph-run-scheduling.ts`, `graph-run-ready-set.ts`, `graph-run-loops.ts`, `graph-run-executors.ts`, `graph-node-*.ts`, `graph-agent-*.ts`, `graph-system-*.ts`, `graph-edge-transforms.ts`, `agent-branch-runner.ts` | |
| Human nodes (208) | `run-human.ts` | `graph-node-human.ts`, `graph-run-attention.ts`, `graph-run-coordinator-status.ts` | `components/graph-run/GraphHumanNodePanel.tsx` |
| Restart and rewind (210) | `run-rewind.ts` | `graph-run-rewind.ts` | `lib/backend/graph-run-rewind.ts` |
| Run view (211) | `run-view.ts` | `commands-registry-graph-runs.ts`, `graph-run-user-actions.ts`, `graph-run-transcripts.ts` | `components/graph-run/`, `stores/graphRunStore.ts`, `lib/backend/graph-runs.ts` |
| Designer (110, 212) | | | `components/graph-designer/`, `stores/graphDesignerStore.ts` |
| Mock runs (213) | `mock.ts`, `mock-pins.ts`, `mock-values.ts`, `schema-sample.ts` | `graph-mock-*.ts`, `commands-registry-graph-mock.ts` | `lib/backend/graph-mock.ts`, `lib/graph-run-navigation.ts`, `GraphMockPinsEditor.tsx` |
| Launch (214) | `launch.ts` | `graph-run-launch.ts`, `commands-registry-graph-launch.ts`, `control-mcp-graph-tools.ts`, `coordinator-graph-actions.ts`, `public-api/actions-graphs.ts` | `components/graph-launch/`, `lib/backend/graph-launch.ts` |
| Describe a graph (215) | `describe.ts`, `describe-prompt.ts` | `graph-describe-service.ts`, `graph-describe-host.ts`, `workflow-result-graph-template.ts`, `storage-graph-describe.ts` | `GraphDescribeControl.tsx`, `GraphDescribeDialog.tsx`, `stores/graphDescribeStore.ts` |
| Items fan-out (401) | `run-fanout.ts` | `graph-run-fanout.ts` | |
| Sub-graphs (402) | `compile-subgraphs.ts`, `subgraphs.ts` | `GraphTemplateService.subgraphResolution` | `graph-designer-subgraphs.ts`, `GraphSubgraphEditor.tsx` |
| Isolated branch worktrees (403) | `isolation.ts`, `isolation-template.ts` | `graph-branch-worktrees.ts`, `graph-system-select.ts` | |
| Per-node user MCP (404) | `native-agent-capabilities.ts` (`userMcpServers`) | each bridge's MCP loader, `opencode-user-mcp.ts` | `GraphMcpServersEditor.tsx`, `graph-designer-mcp.ts` |
| CLI (214) | `public-api-inputs-graph.ts` | `public-api/actions-graphs.ts` | `packages/cli/src/client/commands/graphs.ts` |

## The template model

`GraphTemplateV1` (`template-model.ts`) is plain JSON with hand-written guards
(`validateGraphTemplate`, `parseGraphTemplate`; a strict parse that refuses
duplicate keys). The guard checks shape, grammar, bounds and uniqueness and
reports at most 50 field errors; references and graph rules belong to the
compiler.

**Top level.** `format: "orkestrator.graph"`, `formatVersion: 1`, `id`
(kebab-case, at most 64 characters), `revision` (compare-and-swap counter, 0
for a template never saved), `name`, `description?`, `engine?` (built-ins
only), `parameters`, `roles`, `types?` (custom types), `inputs`, `outputs?`,
`workspace`, `nodes`, `edges`, `loops?`, `limits`, `acknowledgements?`, and
two pieces of designer data the compiler and digest ignore: `layout?` (node id
→ `{x, y}`) and `mockPins?` (item 213).

- **Parameters**: `boolean`, `integer`, `number` (`min?`, `max?`), `string`
  (`maxBytes?`), `enum` (`options`), each with `key`, `label?`,
  `description?`, `default?`. Prompts, `when` and gates read them as
  `params.<key>`.
- **Roles**: `{key, multiplicity: "one" | "panel", maxPanel?, defaultsFrom?}`.
  A role is what a launch binds to models. `defaultsFrom` lists saved action
  defaults (`review`, `review2`, `reviewPreparation`, `fixReviewIssues`,
  `verify`, `pr`, `resolve`, and last, on a panel, `additionalReviewers`).
- **Run inputs** `{name, type, required?}` and **run outputs** `{name, type,
  from: {node, port, outlet?}}`.
- **Workspace**: `{kind: "environment", create?: {kind: "worktree" |
  "container"}}` or `{kind: "none"}`.
- **Limits**: `{maxAgentSessions (≤ 200), maxConcurrentAgents (≤ 32),
  maxTokens?, maxWallClockMs?}`. The compiler proves the worst case of the
  first two fits and the runtime enforces them again. `maxTokens` is a soft
  meter and `maxWallClockMs` a deadline, both enforced at run time
  ([Scheduling](#scheduling)).
- **Acknowledgements**: `{kind: "taint" | "enforcement-floor", digest,
  acknowledgedAt, code?, note?}`, given only by the user in the designer.

**Node kinds** (`GRAPH_NODE_KINDS`). Every node has `id`, `label?`,
`description?`, `inputs?` and `when?` (a predicate; a false or unknown `when`
skips the node). "Execution" is `retry? {attempts, on: [provider-error |
invalid-result | timeout]}`, `timeoutMs?` and `onFailure?` (`fail-run`,
`skip`, `route`).

| Kind | Fields |
| --- | --- |
| `agent` | execution, `outputs?`, `role`, `prompt` (`{builtIn}` or `{template}`), `capabilities` (`{profile, allow?, deny?}`), `workspaceAccess` (`none`, `read`, `write`), `isolation?` (`"worktree"`), `minEnforcement?`, `session?` (`{mode: "fresh"}` or `{mode: "continue", from}`), `replicate?`, `askHuman?` |
| `system` | execution, `outputs?`, `action` (one of `GRAPH_SYSTEM_ACTIONS`), `params?` |
| `gate` | `branches: [{to, when, label?}]`, `otherwise?`; no outputs. Each outlet forwards every input |
| `merge` | `outputs?`, `strategy`: `concat`, `dedupe {key}`, `vote {tie: fail \| first, path?}`, `best {score, prefer?}`, `collect`; `onFailure?` |
| `human` | `form`: `approve`, `edit {edit: <input>}`, `choose {options: [{to, label}]}`, each with `instructions?`; `timeoutMs?`, `onFailure?` |
| `subgraph` | execution, `outputs?`, `template {scope, id, revision?, digest?, path?}`, `params?` (literal or `{param}`), `roles?`, `replicate?` |

**Ports.** Input ports are `{name, type, required? (default true), render?,
collect?, firstIterationFrom?}`. Render modes are `json-frame`, `markdown`,
`summary`, `file` and `on-demand` (default `file` for reference types,
`json-frame` otherwise). `collect` is allowed only on list inputs fed by a
replicated producer: `{wait: all-settled | quorum | first, count?,
minSuccessful, includeFailures}`. Output ports are `{name, type, required?,
provenance? ("cite" | "accountForAll"), choices?}`; `choices` (2–32 values)
only on `decision@N`. Gate and human nodes have outlets instead of outputs
(`graphNodeOutlets`); an edge from one reads `{node, outlet, port}`.

**Edges** are `{id, from: {node, port, outlet?} | {input}, to: {node, port},
transform?, zip?}`. Transforms run in order, at most 8 per edge: `pick
{fields}`, `filter {where}` (an element-relative predicate), `limit {count ≤
1000}`, `flatten {path}` and `adapt {adapter}` (a named built-in adapter such
as `review-report-to-finding-list`). `zip` pairs branch *k* of a replicated
producer with branch *k* of a consumer replicated the same way.

**Loops** are regions `{id, label?, nodes, until, maxIterations (≤ 10),
carry: [{from, to}]}`. A carry delivers a member's output to the next
iteration. A loop member's input may name `firstIterationFrom`: a producer
outside the loop that feeds iteration 1 only, while the carry feeds the rest.
There is no unbounded loop and no cycle outside a loop region.

**Replication** (`replicate`, D9) runs one branch per element of an axis:
`{over: "panel", role}` (one branch per model bound to a panel role),
`{over: "lenses", lenses: [{key, label, instruction, role?}]}`,
`{over: "samples", count}`, `{over: "items", input, maxBranches,
truncate?}` (item 401, [below](#items-fan-out)) and `{over: "cross", axes}` (the
product of 2–3 axes, keys joined with `+` in axis order). At most 32 branches
per node. Branch keys are stable across retries and restarts (`panel.2`,
`lens.security`, `sample.3`, `item.<id>`, `panel.1+lens.tests`). A panel axis
picks the branch's model, otherwise a lens's own role or the node's; a
template that never names `lens` gets the lens appended to its prompt.

**Grammar and examples.** Ids, keys, type refs (`name@major`, `list<…>` at most
two deep) and paths are in `grammar.ts`. `examples.ts` holds the report §9
examples (`multi-review`, `build-pipeline-loop`, `design-bake-off`,
`failure-diagnosis`); tests compile, mock-run and (for §9.3) run them end to
end.

### Items fan-out

`replicate: {over: "items", input, maxBranches, truncate?}` runs one branch per
item of a list input (report §4.4, §5.8; D9, D10). The design note is in
[`plans/graphs/401-items-fanout.md`](../../plans/graphs/401-items-fanout.md).

- **Input.** The port must be `list<T>` (one item per element artifact) or of a
  named type that declares `items` (one item per entry of its item list);
  otherwise `replicate-items-input`. Per branch the port and `{{item}}` hold
  the element; `{{item.index}}` is its 1-based position and `{{item.id}}` its
  stable id.
- **Bound.** The fan-out runs 0 to `maxBranches` branches, times the other axes
  of a `cross`. The cost estimate, `fanout-too-wide` (32 per node) and the
  limits use the worst case.
- **Expansion.** The ready set resolves the position once as a whole: its
  non-zip inputs through their edge transforms, then its `when` on the whole
  list. An absent input or a false `when` skips the position, a failed
  delivery fails it. Otherwise `expandGraphItems` (`graph-run-fanout.ts`)
  records a `GraphItemFanOut` on the run (`run.fanOuts`: the items that run,
  `total`, the truncated ids) and creates the branch activations in the same
  planning round. An empty list records an empty fan-out and one unbranched
  skip. The record is never recomputed: retries, restarts and a recovered
  backend read it.
- **Truncation is explicit.** `truncate: "first"` (default) runs the first
  `maxBranches` items and records the rest; `"fail"` fails the position with
  `budget-exceeded` before any branch starts.
- **Branch keys** are `item.<encoded id>` (`graphItemBranchSegment`: `/` as
  `:`, `+` as `_`, `$` dropped; over 64 characters a hash; a repeated id gets
  `.2`). Derived from the id, so zip edges pair the same item and a filtered
  or reordered input keeps each item's key.
- **Provenance.** `GraphArtifact.sourceItem` is set on elements an edge
  `flatten` cuts from a typed item list, on every output of an item branch and
  on a failed item branch's failure marker. On an item branch the replicated
  port contributes exactly that item to the citable sources, so a per-finding
  fix cites the finding it fixed. Prompts show `Source item: <id>`.
- **Restart and rewind.** Restarting one branch keeps the fan-out. A rewind
  that supersedes one of its source artifacts supersedes the fan-out
  (`supersededBy`), and the position expands again from the live input.

### Sub-graphs

A `subgraph` node uses another template as one node (report §4.1, §4.2, D5).
The compiler inlines it before every other pass, so the plan, the runtime,
restart and rewind only ever see ordinary nodes.

- **Reference.** `template: {scope, id, revision?, digest?, path?}`: a
  built-in, a user template, or a project template of the compiling project
  (`path` pins the file). A `digest` (`graphTemplateDigest`) or `revision` that
  no longer matches is `subgraph-digest-mismatch`, so a child edit never
  silently changes a parent that pinned it; an unpinned child is
  `subgraph-unpinned` (info). Either way a run freezes the plan it launched
  with.
- **Resolution** is injected: `compile(template, {resolveTemplate})` takes a
  synchronous `GraphTemplateResolver` (`subgraphs.ts`). The default resolves
  built-ins. The backend (`GraphTemplateService.subgraphResolution`) reads
  every child ahead, nested ones included, and project children only while
  trusted at their current digest; its compile cache key includes each child's
  digest. The designer fetches user and project children once per project
  (`graph-designer-subgraphs.ts`).
- **Inlining** (`compile-subgraphs.ts`). Child nodes, edges and loops get plan
  ids `<subgraph node>/<child id>` (`GRAPH_PLAN_ID_PATTERN`, at most 128
  characters). Parent edges into and out of the node are rewritten to the
  child's inner edges (transforms concatenated); run outputs, carries,
  `firstIterationFrom` and `until` roots likewise. Child roles map through
  `roles` or by key; child parameters bind to literals or `{param}`, else their
  defaults; child types merge (`subgraph-type-conflict`). Nesting is at most 4
  deep (`GRAPH_SUBGRAPH_MAX_DEPTH`; `subgraph-recursive`) and the flat plan is
  bounded by `GRAPH_PLAN_BOUNDS`. The child's limits, layout and
  acknowledgements are dropped: cost is summed on the flat graph against the
  parent's limits, the parent acknowledges warnings on inlined nodes, and
  inlined agents compile against the parent's ceiling.
- **Not supported on the node** (`subgraph-unsupported`): `replicate`, `when`,
  `retry`, `timeoutMs`, `onFailure`, a child with loops inside a parent loop,
  and a session continued from the sub-graph. A sub-graph that cannot be
  inlined stays an opaque node and the compile has an error.
- **Plan and runtime.** `plan.subgraphs` records each instance (the resolved
  child, its parameter scope, role map, inlined node ids and port map). The
  runtime reads an inlined node's parameters through `graphPlanScopeParams`.
- **Multi Review as a block.** A built-in child's `engine` is ignored when
  inlined: its nodes run on the graph runtime (`subgraph-engine-copy`, info).
  The built-in has optional outputs `clean` and `fixed` so a parent can ship
  the result itself; the report §9.3 example does
  (`graph-run-subgraphs.test.ts`).

### Isolation

D3 keeps one writer per workspace. A replicated writer may set `isolation:
"worktree"` so each branch writes its own Git worktree; the runtime side is in
[Isolated branch worktrees](#isolated-branch-worktrees).

## Types

Every port and edge is typed (D8). The library (`types.ts`, `new
GraphTypeLibrary(customTypes)`) resolves `name@major` refs, `list<T>` and the
anonymous shapes transforms produce.

**Built-in types** (`GRAPH_BUILT_IN_TYPE_NAMES`; all version 1 except
`review-package@2`):

| Type | Family | Content |
| --- | --- | --- |
| `text@1`, `markdown@1` | text | `{text}`, `{markdown}` |
| `ticket@1` | ticket | title, kind, description, criteria `{id, text}`, comments |
| `workspace@1` | workspace | `{branch, headRef, baseRef}`: the commit work started from or ended on |
| `validation-plan@1`, `validation-results@1` | report | validation commands for one commit; the outcome of running them |
| `review-package@2` | package | sealed review package (a reference artifact) |
| `review-report@1`, `finding@1` | report | structured review report (items `issues` of `finding@1`); one issue |
| `verification-verdict@1`, `fix-result@1` | report | per-criterion verdict; what a fix changed |
| `pr-description@1`, `pr-result@1` | text, report | title and body for a system-opened PR; the PR a run opened |
| `check-summary@1` | report | rolled-up CI state |
| `decision@1` | decision | `{choice, rationale}`; `choice` narrowed by the port's `choices` |
| `file-list@1` | report | `{files: [{path, reason}]}` |
| `error@1` | error | a routed failure `{node, cause, code, message, attempts, retryable}` |

Built-in types carry budgets and domain validators (`type-validators.ts`) and,
where one exists, the workflow result kind they map to; backend-only checks
(`workspace-commit`, `file-list-paths`, `validation-plan`,
`review-package-reference`) run through the result registry's environment
validator hook.

**Custom types** (`ArtifactTypeDef`): `name`, `version`, `schema`, `storage:
"value" | "reference"`, `budgets {maxBytes, maxStringBytes?, maxItems?}`,
`items? {path, idPrefix}` (an item list with stable ids), `sharedFields?`,
`render? {markdown?, summary?}` and `example?`. `checkArtifactTypeDef` refuses
built-in names and checks the example against budgets and schema.
`draftGraphSchemaFromExample` drafts a schema.

**The schema subset** (`schema-subset.ts`) is what every provider's structured
output accepts: keywords `type`, `anyOf`, `properties`, `required`,
`additionalProperties`, `items`, `enum`, `const`, `minimum`, `maximum`, plus
the annotations `description`, `title` and `x-orkestrator-sources`. The root is
an object, every object lists every property in `required` with
`additionalProperties: false`, an optional field is `anyOf [X, {type:
null}]`, and `anyOf` is never at the root or nested. Refused keywords
(`pattern`, `format`, `$ref`, `oneOf`, length and count bounds, …) get a hint;
budgets replace the bounds. Providers never see `x-orkestrator-sources`
(`graphProviderSchema`).

**Assignability** (`graphTypeAssignability`): identical, structural (with
`budgetCheck: true` when the runtime must enforce the target's budgets on the
edge) or refused (`cardinality`, `version_mismatch`, `nominal_target`: a
built-in with a validator accepts only itself, `storage_mismatch`,
`schema_mismatch`). Adapters (`graphTypeAdapters`):
`review-report-to-finding-list`, `review-report-to-markdown`,
`ticket-to-markdown`, `fix-result-to-file-list`, `text-to-markdown`,
`markdown-to-text`. `graphTypeFamily` colours ports (`text`, `ticket`,
`report`, `workspace`, `decision`, `package`, `error`, `list`, `unknown`).

**Values** are checked by `validateGraphArtifactValue`: budgets, then schema,
then the domain validator.

## Predicates

`when`, gate branches, loop `until` and edge `filter` use one bounded JSON
predicate language (`predicate-shape.ts`). Leaves are `{path, op, value?}` with
`eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`, `exists`, `empty`, `nonEmpty` and
`count` (with a comparison); combinators are `{all}`, `{any}` and `{not}`.
Depth 8, 64 nodes, `in` lists of 64, strings of 1 KiB.

Paths start at `params`, `run` (`run.iteration`), `<node>.<port>` (loop
`until`) or an input port; a filter path is relative to one list element.
Paths never step through a list; `count`, `empty` and `nonEmpty` test one.
`checkGraphPredicateTypes` checks paths and operators against the input
schemas; the compiler reports failures as `condition-invalid`.

Evaluation (`evaluateGraphPredicate`) is total and **three-valued**: a missing
or mistyped value makes a leaf `unknown`, `not` keeps unknown, `all` is false
if any child is false, `any` true if any is true. Every decision takes only
`true`, so unknown is false: a gate falls to `otherwise`, a `when` skips, a
loop runs another iteration (up to its bound). At most 8 unknown paths are
reported.

## Prompt templates and the system contract

An agent prompt is a built-in prompt id or a logic-less template
(`prompt-template.ts`, D13): a Mustache subset with `{{a.b}}`, `{{.}}`,
`{{#list}}…{{/list}}`, `{{^x}}…{{/x}}`, partials `{{> input.<port>}}` and
comments. Nothing is executable: unsupported tags and unresolved names render
literally, only own properties of plain objects are read, and parsing and
rendering are bounded and never throw.

- **Variables:** `input.<port>`, `params.<key>`, `run.iteration`, `lens.*`,
  `branch.{index, key, count}`, `item`, `item.index`, `item.id`, and `ticket`
  when the template has a `ticket@N` input.
- **Evidence frames** (invariant 5). Each input partial renders one
  `<orkestrator-evidence port type render>` frame in its render mode:
  `json-frame` (framed JSON), `markdown` (the type's markdown template,
  escaped), `summary` (`field: value` lines), `file` (path, SHA-256 and size of
  a reference artifact) or `on-demand` (ids and a `read_artifact` hint).
- **Built-in prompts** (`GRAPH_BUILT_IN_PROMPT_IDS`): `review-package-preparation`,
  `discovery-review`, `consolidation`, `fix-review-issues`, `address-review`,
  `build`, `pipeline-fix`, `verify`, `pull-request-description` and
  `resolve-conflicts`; the backend binds them to today's builders
  (`graph-agent-builtins.ts`; the last two are push-free).
- **The locked system contract** (`graphSystemContract`, `system-contract.ts`)
  is generated, never editable, and appended after the user part so the shared
  prefix stays cacheable across branches: the capability statement
  (`describeGraphCapabilities`: profile, denials, granted tools, the
  enforcement tier) with the untrusted-evidence rule, the unattended policy
  frame, the isolated-branch worktree frame when the node is isolated, and the
  result instruction for the node's output ports (`submit_<port>` and
  `validate_<port>`, the status tool `get_workflow_result_status`,
  `report_progress`; `submit_graph_output` on the OpenCode broker).
- **Rendering.** `renderGraphNodePrompt` returns `{system, user, prompt,
  bytes, diagnostics}`; the executor and the designer preview call the same
  function.
- **Size and lints.** `estimateGraphNodePromptSize` reports the nominal and
  worst-case bytes against the 160 KiB input ceiling, with fan-in list sizes
  from the producers' branches. Lints (`prompt-lint.ts`) flag unbound and
  unknown variables, branch variables before large shared inputs (cache
  prefix), prose-only output instructions, profile contradictions, unused
  inputs and built-in prompt mismatches. All codes are in
  `GRAPH_PROMPT_DIAGNOSTIC_CODES`.

## Capabilities and enforcement

### Profiles

A node names a profile and may adjust it with `allow` and `deny`
(`capability-profiles.ts`, report §6.2). Every profile, `custom` included,
denies `git.push` and `github.write` (D12): only system nodes push or write
to GitHub.

| Profile | Denies (besides push and GitHub writes) | Allows |
| --- | --- | --- |
| `observer` | file writes and patches, shell, network, sub-agents, commits | |
| `reviewer` | file writes and patches, mutating shell, network, commits | |
| `verifier` | file writes and patches, commits (full shell; a guard checks afterwards) | |
| `researcher` | file writes and patches, shell, network, commits | hosted web search |
| `builder` | nothing | |
| `custom` | nothing; the node's `deny` narrows it | |

Capability names are the native vocabulary (`file.write`, `file.patch`,
`shell`, `shell.mutate`, `network`, `web.search`, plus `git.commit`,
`git.push`, `github.write`, `subagents`), `mcp:<server>` and
`orkestrator:<group>` (`tickets.read`, `tickets.write`, `mail`, `artifacts`,
`schedules`; opt-in, enforced by the backend's tool server). Released bridges
only know the first six, so `nativeAgentPolicyForBridge` sends the newer
denials as `capabilityPolicy.extendedDeny` with per-bridge stand-ins
([agent-engines.md](agent-engines.md)).

`compileGraphCapabilities({spec, environment, ceiling?})` layers the profile
over the environment's own execution policy and the project's ceiling. The
result only narrows (invariant 7): sandbox, approvals, network and tool policy
are the environment's, denials are the union of all three layers, and hosted
search survives a network denial only where every layer allows it. It reports
`readOnly` (file tools and mutating shell denied), the granted Orkestrator
groups and MCP servers, and what the ceiling and environment removed. Checks
(`GRAPH_CAPABILITY_ISSUE_CODES`): `capability-remote-write` (error),
`capability-workspace-write-denied` and `capability-workspace-read-writable`
(errors), `capability-allow-unused`, `capability-mcp-grant` and
`capability-mcp-grant-read-only` (warnings).

**The ceiling** (D18) is per project: `{deny, allow?: ["web.search"]}`, at most
64 entries, stored in the `graph-templates` store and editable through
`graph_capability_ceiling_get`/`_set`. It caps every template compiled for the
project, built-in, user or project.

### Enforcement tiers

`agentPolicyEnforcement(policy, platform, host)` (`capability-enforcement.ts`)
rates what a provider does with a policy: `enforced` (the provider or OS
blocks it), `provider-configured` (the provider is configured to refuse it)
or `advisory` (only the prompt and the post-hoc guards hold it).

- **Read-only policies** use the coordinator table
  ([coordinator.md](coordinator.md)): Codex and Pi enforced; Claude enforced
  with its command sandbox, else provider-configured; OpenCode and Cursor
  provider-configured; Grok advisory.
- **Other policies** are judged per axis (`workspace`, `shell`, `network`,
  `commit`, `remote`): file tools are provider-configured on Claude and Cursor
  and advisory elsewhere; a shell denial is provider-configured on Cursor and,
  for the whole shell, on Claude; network is provider-configured only where
  commands are sandboxed without network; commits and remote writes are always
  advisory (the guards hold them). Secondary axes (`web-search`, `subagents`,
  `mcp`) are reported but never lower the tier. So `builder`, `custom` and
  `verifier` are advisory on every provider.
- **The researcher exception.** A Claude `researcher` runs as an ordinary turn
  so hosted search stays available: at most `provider-configured`
  (`graphAgentNodeEnforcement`).

**Floors** (D4). `minEnforcement` defaults to `provider-configured` for
read-only profiles and nothing otherwise. No enabled provider meeting a
node's floor is `enforcement-unmet` (error); a floor below the default is
`enforcement-floor-lowered`, a warning that needs an acknowledgement. The
designer shows the per-provider matrix (`agentPolicyEnforcementMatrix`); the
launch pickers and dispatch re-check it ([Guards and enforcement](#guards-and-enforcement)).

### Per-node user MCP servers

A graph node gets **none** of the user's own MCP servers unless it is granted
them (item 404): `mcp:<server>` in a node's `allow` grants that server for the
node's session; in `deny` (the node's, the ceiling's or the environment's) it
removes it, and a denial wins. Every compiled policy carries
`capabilityPolicy.userMcpServers` (sorted, `[]` for none). The field only
**selects** among servers the user configured in each provider's own files
(Settings → MCP servers); it never carries a definition, so a template,
including a project template, can name a server but cannot add one or change
its command, URL, environment or headers. Reserved Orkestrator servers are
never filtered. Names only are logged.

How each provider loads exactly the selection (`NATIVE_AGENT_USER_MCP_SELECTION`):

| Provider | Mechanism | Grant delivered on | MCP axis |
| --- | --- | --- | --- |
| Claude | inline `mcpServers` filtered to the grant plus `strictMcpConfig: true`, so the CLI reads no MCP file and no plugin server loads; granted tools are approved up front unless the policy asks, and a read-only turn's hook admits them | ordinary and read-only turns | provider-configured |
| Codex | `config/read` lists the effective `mcp_servers`; every other server gets `mcp_servers.<name>.enabled = false` on `thread/start`/`resume`/`fork`, a granted one `default_tools_approval_mode = "approve"` unless the policy asks; an unreadable table or an undisableable name refuses the thread | ordinary and read-only turns | provider-configured |
| Pi | the bridge's own MCP client starts only the granted servers; the read-only gate admits their tools by exact name | ordinary and read-only turns | enforced |
| OpenCode | one shared `opencode serve` per directory: the session's permission rules deny `<server>_*` for every server `mcp.status` lists outside the grant (re-applied when the list changes; an unreadable list refuses the session); the other servers still run | ordinary and read-only turns | provider-configured |
| Cursor | no settings source (each would load all its servers); the bridge reads `~/.cursor/mcp.json` (and `.cursor/mcp.json` with project resources) and passes the granted servers inline; such a session also loses the user's and project's Cursor rules and plugins | ordinary turns only | provider-configured |
| Grok | none: Grok loads every server in its own configuration and ACP `session/new` can only add | never | advisory |

The compiler warns `capability-mcp-grant` once per enabled provider that cannot
deliver a grant (Grok always, Cursor for a read-only node), and
`capability-mcp-grant-read-only` when a read-only node is granted a server (an
MCP server acts with the user's rights, outside the read-only boundary; the
workspace guard still checks afterwards). Bridges older than item 404 ignore
`userMcpServers` and load every configured server. The designer's
capabilities form (`GraphMcpServersEditor`) lists the user-scope servers of
every provider with Off, Grant and Deny.

## The compiler

`compile(template, options?)` (`compile.ts`) never throws. Options: custom
`types`, enabled `providers`, the `ceiling`, the launch `environment` policy,
the probed `host`, `promptCeilingBytes` and `resolveTemplate`. It returns `{ok,
launchable, plan, diagnostics, omittedDiagnostics, cost,
pendingAcknowledgements}`; `launchable` means no errors and no pending
acknowledgement.

**Passes:** the guard, sub-graph inlining, references and node rules
(`compile-refs.ts`), system nodes (`compile-system.ts`), topology and loops
(`compile-graph.ts`), ports and edges (`compile-ports.ts`), conditions,
agents (capabilities, floors, sessions; `compile-agents.ts`), workspace rules
(`compile-workspace.ts`), taint (`compile-taint.ts`), cost and limits
(`cost.ts`), prompt lints (`lint.ts`), stale acknowledgements, then the plan
(`compile-plan.ts`).

**Diagnostics** are `{code, severity, message, nodeId?, edgeId?, loopId?,
path?, port?, offset?, length?, detail?, acknowledgement?}`, errors first, at
most 500. Every compiler code, its severity and a one-line summary are in one
registry, `GRAPH_COMPILE_DIAGNOSTICS` in
[`compile-diagnostics.ts`](../../packages/protocol/src/graphs/compile-diagnostics.ts),
with one test per code; capability (`capability-*`) and prompt (`prompt-*`)
codes pass through from their own lists. Families:

| Family | Examples |
| --- | --- |
| Template and types | `template-invalid`, `type-invalid`, `type-conflict`, `type-unresolved` |
| References | `unknown-node`, `unknown-port`, `unknown-outlet`, `outlet-required`, `unknown-role`, `role-multiplicity` |
| Sub-graphs | `subgraph-unresolved`, `subgraph-digest-mismatch`, `subgraph-recursive`, `subgraph-unsupported`, `subgraph-unpinned` (info), `subgraph-engine-copy` (info) |
| Ports and system nodes | `replicate-items-input`, `error-port-type`, `route-without-error-port`, `system-param-invalid`, `system-input-missing` |
| Topology and loops | `graph-cycle`, `loop-unbounded`, `loop-bound-exceeded`, `loop-overlap`, `loop-carry-outside`, `first-iteration-invalid` |
| Edges and inputs | `edge-type-mismatch`, `edge-cardinality`, `edge-transform-invalid`, `edge-zip-invalid`, `input-unbound`, `input-multiple-producers`, `collect-unsatisfiable`, `merge-invalid`, `condition-invalid` |
| Workspace (D3) | `workspace-concurrent-writers`, `workspace-read-write-race`, `replicated-writer`, `isolation-*`, `select-without-isolated-branches` |
| Enforcement and taint | `enforcement-unmet`, `enforcement-floor-lowered`, `taint-reaches-side-effect`, `acknowledgement-stale` (info) |
| Sessions | `session-source-invalid`, `session-role-mismatch`, `session-not-predecessor`, `session-replicated` |
| Limits and cost | `limit-agent-sessions`, `limit-activations`, `fanout-too-wide`, `concurrency-capped` (info) |
| Hygiene | `output-unused`, `run-input-unused`, `outlet-unused`, `iteration-outside-loop`, `workspace-unpinned` |

**Workspace rules** (D3). Two writers that can run at the same time, or a
reader that can run beside a writer, is an error. A replicated writer needs
`isolation: "worktree"`. System actions declare their access
(`GRAPH_SYSTEM_ACTION_WORKSPACE`): `prepare-environment` and
`select-workspace` write; validation, push and pull-request actions read.

**Taint** (§5.13). Sources are agents that keep web search or network after
the ceiling and environment, and `wait-for-checks` (external CI output). Sinks
are side effects: shell with network, remote writes, push, pull request,
validation commands, sub-graphs. Each path to a sink is one
`taint-reaches-side-effect` warning keyed by `graphWarningDigest`; a matching
acknowledgement turns it into info, and a change to the path changes the
digest.

**Cost** (`GraphCompileCost`, `cost.ts`): best and worst agent sessions and
activations, peak parallelism (a max-weight antichain), per node, and
`incomplete` when something could not be bounded. The launch dialog scales it
by the bound panel sizes.

**The plan** (`CompiledGraphPlan`, `plan.ts`): `format:
"orkestrator.graph-plan"`, the template's id, revision and name, parameters,
roles, resolved types, inputs, outputs, workspace, topological `order`, nodes,
edges, loops, `subgraphs?`, limits, cost, acknowledgements and `context
{ceiling, environment}`. `digest` is SHA-256 over the canonical plan without
itself (`graphPlanDigest`, `verifyGraphPlanDigest`); `templateDigest` is
`graphTemplateDigest`, which hashes the template without `layout` and
`mockPins` (nodes, edges and loops sorted by id), so trust and approvals
survive moving nodes or editing mock pins. The backend keeps a 256-entry
compile cache keyed by template digest, context and the sub-graph resolution.

## Built-in templates

`builtins/` describes `multi-review`, `build-pipeline` (engines `active`) and
`looped-review` (`retired`), each with a `stages` map from node to engine
stage. Pinning tests (`graph-builtin-templates.test.ts`,
`builtins/*.test.ts`) fail when either the engine or the template changes
alone. A built-in cannot be saved, launched or mock-run as a graph
(`engine-template`); duplicating it drops `engine`, and the copy runs on the
graph runtime. What the templates cannot express (engine-only behaviours such
as conflict handling and mergeability waits) is listed in
[`108-builtin-templates.md`](../../plans/graphs/108-builtin-templates.md).

## Library, trust and sharing

**Scopes** (`library.ts`, `GraphTemplateService`). Built-in templates come
from code. User templates live in the `graph-templates` store (at most 200,
32 MiB), saved with revision compare-and-swap. Project templates are
`.orkestrator/graphs/*.graph.json` files in the project checkout (at most 64
files, 1 MiB each, 16 MiB per project), read confined to the checkout (no
symlinks, regular files only) and watched (one non-recursive watcher per
project, at most 32, 250 ms settle); broken files are listed as problems.
Changes announce the `graph-template` resource.

**Trust** (D2). Built-in and user templates are trusted. A project template is
`untrusted` until the user approves its digest, and `changed` (untrusted
again) as soon as its digest differs from the approved one
(`graphTemplateTrustState`). An untrusted or changed template can be viewed,
compiled and duplicated at the digest shown, but not launched, used as a
sub-graph or signed.

**Commands** (`commands-registry-graphs.ts`): `graph_templates_list`,
`graph_template_get`, `graph_template_save`, `graph_template_delete`,
`graph_template_duplicate`, `graph_template_compile {ref | template,
forLaunch?, includePlan?}` (with `forLaunch`: `blockedBy` and
`providerChoices`), `graph_template_import`, `graph_template_export`
(canonical text: sorted keys, two-space indent, trailing newline),
`graph_template_trust {approve | revoke, digest}` and
`graph_capability_ceiling_get`/`_set`. Refusals carry
`GRAPH_TEMPLATE_ERROR_CODES` (`invalid-request`, `not-found`,
`revision-conflict`, `invalid-template`, `untrusted`, `digest-mismatch`,
`limit`, `invalid-ceiling`, `engine-template`).

**Share bundles** (item 405, `sharing.ts`). `orkestrator.graph-bundle` version
1 is one canonical JSON file (`<id>.graph-bundle.json`, at most 2 MiB): the
template with its custom types, `digest` (`graphTemplateDigest`),
`contentDigest` (SHA-256 of the canonical export text, layout and pins
included), `exportedAt`, an optional one-line `author`, and an optional
Ed25519 `signature` over a fixed payload naming both digests. Each
installation has one keypair, created on first use in the backend
(`graph-template-signing.ts`, `node:crypto`; the private key is never returned
or logged), and a list of at most 64 trusted public keys with labels.

- `graph_template_share_export {ref, sign?, author?}`. An untrusted project
  template is never signed.
- `graph_template_share_import {text, projectId?, confirmDigest?}`. A tampered
  bundle (either digest or the signature fails) is refused (`digest-mismatch`,
  `content-digest-mismatch`, `signature-invalid`, or `invalid-bundle`,
  `invalid-template`). Otherwise the first call returns a preview (integrity:
  `trusted-signer`, `untrusted-signer` with the fingerprint, `unsigned`, or
  `no-digest` for a plain template; compile counts; the capability summary;
  taint warnings) and saves nothing; the same call with `confirmDigest` equal
  to the bundle's digest saves it as a new user template (`engine` dropped, a
  taken id renamed). The confirmation is the approval.
- `graph_sharing_keys {create?}` and `graph_sharing_key_trust {add | remove,
  publicKey, label?}`.

**Project template review.** Approving a project template keeps its approved
canonical text (store collection `approvals`; at most 256 KiB per template and
4 MiB per project, oldest dropped first with the digest kept).
`graph_project_template_review {projectId, path?}` lists untrusted and changed
templates with their digest, compile counts, capability summary
(`graphTemplateCapabilitySummary`: agent nodes per profile, added
capabilities, writers, Orkestrator groups, system actions and their side
effects, what the ceiling removed, taint) and a line diff against the last
approved copy (at most 400 lines). `graph_project_template_review_decide
{projectId, path, digest, decision}` approves at the reviewed digest, or
rejects: the digest is recorded as rejected (a new digest asks again) and any
earlier approval is kept, so reverting the file restores trust.

## Storage

Four record stores (`storage-stores.ts`; details in [storage.md](storage.md)):

| Store | Rows | Owner |
| --- | --- | --- |
| `graph-templates` | collections `templates` (one user template per row, revision CAS), `projects` (ceiling, trust records, `launchDefaults`), `sharing` (signing keys), `approvals` (approved copies and rejections per project) | project rows deleted with the project |
| `graph-runs` | one `GraphRun` per run, revision compare-and-swap; writes announce `graph-run` | the environment (deleted with it); environment-less runs by retention |
| `graph-artifacts` | one row per artifact, a per-run usage row that enforces the budgets, and the effect journal (`<run>/effect:<sha256 of key>`) | the run |
| `graph-describe` | the latest "Describe a graph" job per environment | the environment |

**The run record** (`GraphRun`, `run-model.ts`) freezes the compiled plan, the
template ref and digest, bindings, parameters and inputs at launch (invariant
2), with `status` (`provisioning`, `running`, `waiting`, `paused`,
`complete`, `failed`, `cancelling`, `cancelled`), `activations`, `fanOuts`,
`rewinds`, `usage`, `launch` (`{requestedBy: user | cli | coordinator |
schedule, create?, ticket?, scheduleId?}`, ids only), and the `mock` flag. A
**node activation** is one attempt at one node position, keyed
`node#iter=<n>[#branch=<key>]#attempt=<n>` (`run-identity.ts`), with state
`waiting`, `ready`, `admitting`, `running`, `awaiting-human`, `complete`,
`failed`, `skipped`, `cancelled` or `superseded`, its bound inputs and
outputs, error and cause, outlet, session, policy, enforcement and guard
results. The run guard (`run-guards.ts`) validates the record before every
save; `maxRecordBytes` is 16 MiB. `saveGraphRun(run, expectedRevision,
{supersede?})` is compare-and-swap inside the row's transaction (artifact
supersede marks commit in the same transaction); the plan, project and a set
environment never change (`plan-changed`); writes are refused while the
environment is missing or being deleted; a record of a newer format is
refused (`newer-format`), never rewritten. Errors are `GraphStorageError` with
a code and, for bounds, `GRAPH_RUN_LIMIT_CODES`. Environment deletion removes
the runs' reference files first (best effort), then run, artifact, usage and
effect rows in one transaction per run, then their transcripts.

**Artifacts** (`graph-artifacts.ts`, invariants 3 and 4). Every artifact is
validated against its type from the frozen plan before it is stored, and is
immutable: a retry or rewind adds artifacts and marks old ones superseded.
The digest hashes type and canonical payload; the id hashes digest, run,
producer, lineage and workspace, so equal content from two activations stays
two artifacts. Value artifacts (at most 384 KiB) are stored inline; reference
artifacts are sealed files under `.orkestrator/graph-artifacts/<run>/<sha256>`
in the environment (Git-excluded, written read-only without following links,
hash-verified at the source before each read; in a container inside it, so no
content crosses the boundary). Per run: 32 MiB inline, 256 MiB on disk, 8,192
artifacts. Item ids (`run-items.ts`) are
`<node>[/iter-<n>][/<branch>]/<idPrefix>-<k>` (`review/panel.2/issue-3`).

**Effects** (`storage-graph-effects.ts`): one row per side effect of a system
node, `intended` before and `done`/`failed` after, keyed by the action's
idempotency key; a mock run records `simulated` rows. `graph_run_effects
{runId}` lists them (newest 500).

## The runtime

### Supervisor domain

Runs are driven by the shared `KeyedWorkflowSupervisor` as the `graph-run`
domain (`graph-run-supervisor.ts`, `KEYED_SCHEDULING_DOMAINS`): one key per run
that owes work, scoped wakes, admission through the `workflow-provider` pool,
at most 8 passes at once and a 30 s safety discovery over the store. The
obligations:

| Obligation | Run state | Cadence |
| --- | --- | --- |
| `provision` | `provisioning` | 1 s, without a provider slot |
| `cancel` | `cancelling` | 1 s until every admitted activation stopped |
| `observe` | an activation `admitting` or `running` | 3 s plus a stable per-run spread; 1 s while admitting |
| `advance` | `running`/`waiting` with ready work | 1 s, and woken when a workspace lock is released |
| `await-human` | only `awaiting-human` activations admitted | 30 s safety, without a provider slot; answers wake the run |

`result-accepted` wakes only the run that owns the accepted slot
(`GraphRunResultKeys` maps each admitted activation's result keys to it).
Environment and provider transitions wake the environment's runs.
`ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=graph-run` disables graph runs: nothing
is launched or advanced, stored runs stay readable and cancellable.

`GraphRunService` (`graph-run-service.ts`) creates, reads, cancels, pauses,
resumes, restarts and rewinds runs; executors register on
`GraphRunService.executors`.

**Recovery.** Startup needs no renderer: the first discovery registers every
run with an obligation and seeds the workspace locks and the result-key index;
each run's first pass hands its admitted activations to their executors'
`recover`. Until that discovery completes, nothing that touches a workspace is
admitted. `admitting` is saved before any `start`, and executors are
idempotent per activation key. The agent executor journals `dispatching`
before a prompt is sent and recovers through the bridge's dispatch journal
(`recoveredDispatchAcceptance`): `dispatched` is promoted to sent, `absent` is
re-sent under the same request id, `lost` fails the branch, anything else
waits. System jobs restart under the effect journal. So a restart never
re-dispatches blindly (`graph-run-journal.test.ts`,
`graph-node-agent-interleaving.test.ts`, whose seeds include a replicated
node of 2–4 panel or lens branches collected by a fan-in, with the backend
dying during the branches' dispatch). There is no controller lease;
safety rests on compare-and-swap everywhere.

### A pass

One pass (`graph-run-pass.ts`) runs under the run's lock and reads only its
row:

1. provisions the environment while `provisioning` (the
   `GraphRunEnvironmentProvisioner`, D7: a new worktree or container, linking
   the launch's ticket; a run that fails before it has an environment is
   swept by the launch service);
2. while `cancelling`, cancels admitted work through the executors and
   settles the run;
3. otherwise hands each admitted activation to its executor: `recover` once
   per backend process, `start` again while `admitting`, `observe` when due,
   `cancel` past the node's `timeoutMs`;
4. unless paused, plans to a fixpoint, loading the artifact values planning
   needs and storing the artifacts it asks for (edge transform results,
   routed `error@1`), admits under the workspace locks and limits, saves (the
   journal point) and starts what it admitted; gates and merges settle at once
   and feed another round; branches a `first` fan-in no longer needs are
   cancelled (`surplus`);
5. derives the run status and saves again if anything changed. `waiting`
   means everything admitted is `awaiting-human` and nothing is ready;
   `complete` needs every position settled, every loop done and every
   required run output produced (else the run fails naming the missing
   outputs). A failure while work is admitted goes through `cancelling`
   (reason `run-failed`).

Executor calls are bounded (4 starting, 8 observing, 4 per provider, ceiling
16). A save is compare-and-swap; a conflict ends the pass and the next one
starts from the stored record.

### Scheduling

Planning (`graph-run-scheduling.ts`, pure) applies retries and `onFailure`,
loop progress (`graph-run-loops.ts`) and the **ready set**
(`graph-run-ready-set.ts`), in the plan's topological order, so a skip
propagates within one call:

- An input resolves from its edges and carries. An edge delivers on all
  iterations, the first only or later ones (`firstIterationFrom`); a carry
  delivers from iteration 2. A producer in the consumer's loop is read at the
  same iteration; one in a loop the consumer is outside of is read at that
  loop's last iteration once the loop is done.
- A completed producer delivers its artifact; one that took another outlet,
  skipped, was cancelled or failed without a routed error delivers nothing
  (absent). A taken outlet delivers what the gate or human node forwarded.
- A position is `skipped` when a required input is absent or `when` is not
  true; `failed` when a fan-in's collect policy cannot be met or an edge
  delivery fails; `ready` once every input resolves.
- Edge transforms and unproven budgets go through `planGraphEdgeDelivery`
  (`graph-edge-transforms.ts`): the same artifacts (filter, limit), new
  artifacts the pass stores first (pick, flatten, adapt), or a failure.
- At most 200 live activations and 2,000 in history; an append beyond them
  fails the run with `budget-exceeded`.

**Workspace locks** (D3): at most one writing activation per workspace and no
reader beside a writer, across every run on the environment
(`GraphWorkspaceLocks`); a blocked writer is not overtaken in the same pass.
An isolated branch holds a reader on the run's workspace. A mock run holds no
locks (`graphRunLockedWorkspace`).

**Admission** (`selectGraphAdmissions`): `limits.maxConcurrentAgents` admitted
agent activations at once and `limits.maxAgentSessions` over the run's life
(`usage.agentSessions`, counted at admission); an agent that can never get a
session fails with `budget-exceeded`. A blocked activation waits with its
block (`concurrency`, `token-budget`, `workspace-lock`, `worktree-limit`, or
`recovering` until the first discovery after a restart).

**Token and wall-clock limits.** `limits.maxTokens` is a soft meter over
`usage.tokens`, the tokens finished agent activations reported. Once it is
reached no new agent activation is admitted: while agents of the run are
still running a ready one waits (`token-budget`) and the running ones finish;
once none runs it fails with `budget-exceeded` and an error naming the meter
(`limits.maxTokens N; M used`), and its `onFailure` decides the run (the
default fails it). The meter never stops running work, never applies to
gates, merges, system or human nodes, and never to a mock run (which reports
no tokens). `limits.maxWallClockMs` counts from `startedAt`, paused time
included. A pass over a running, waiting or paused run past it fails the run
with `budget-exceeded` ("exceeded its wall-clock limit of …"): waiting work
is cancelled and admitted work, running agents and human nodes awaiting a
person alike, is stopped through the executors with reason `run-failed`. A
run's next pass is never due later than its deadline, so a paused run or one
waiting on a person still fails on time. The run view's header shows usage
against both limits when the template sets them.

### Executors

`GraphNodeExecutor` (`graph-run-executors.ts`) is `{kind, start, observe,
cancel(ctx, reason), recover?}`, each returning a `GraphActivationReport`:
`unchanged`, `running`, `awaiting-human`, `complete {outputs, outlet?}`,
`failed {error, cause}` or `cancelled`, with facts (session, policy,
enforcement, baseline, guards, usage) and an `observeAfterMs` hint (`null`:
only when woken). A throw fails the activation with `system-error`. `start` is
idempotent per activation key; cancel reasons are `run-cancelled`,
`run-failed`, `timeout`, `surplus` and `restarted`. The registry holds one
live executor per kind (`agent`, `system`, `gate`, `merge`, `human`) and mock
executors registered with `{mock: true}`; a mock run never falls back to a
live `agent` or `system` executor (gates, merges and a paused human node use
the live ones). `GraphExecutorContext.journal(facts)` writes activation
facts under the run's lock.

### The agent executor

`graph-node-agent.ts`. One activation is one branch of the shared
`AgentBranchRunner` (`agent-branch-runner.ts`), extracted from Multi Review's
reviewer fan-out: session creation, the dispatch journal, proof-based
recovery, observation, repair, the result reminder, continuation and
metering. Multi Review's and the Build Pipeline's reviewer fan-outs
(`review-fanout.ts`) and "Describe a graph" run on the same runner. What the
graph executor adds:

- **Policy first.** The node's capabilities are compiled against the
  environment's real policy (its `automated-review` policy, `build-pipeline`
  for writers) and the project ceiling, the tier is judged for
  the binding's provider on the live host, and both are recorded on the
  activation before the session exists (`graph-agent-policy.ts`). A
  read-only policy runs as a read-only turn (the Claude researcher is the
  exception). A tier that dropped below the node's floor since launch fails the
  activation with `guard-violation` before any session.
- **The journal is the run record.** Every runner write goes through
  `context.journal`, so `dispatching` is durable before the prompt is sent.
- **Sessions.** `session: "fresh"` (default) starts a provider session per
  activation; `"continue"` sends the turn into the session of the activation it
  continues (the compiler proved it runs before, on the same role, unreplicated).
  A restart is a new attempt with a fresh session.
- **Completion** when every required port has an accepted result: the guards
  certify, then values become artifacts with lineage (the consumed inputs),
  the workspace commit, item ids and `sourceItem`. `workspace@1` outputs get
  no slot; they are filled from Git after the turn. Agents produce value
  artifacts only. Input item ids are rendered into prompts (`sourceId` in a
  JSON frame, a "Source ids" line otherwise), so citing consolidators can
  name them.
- **Repair.** At most 3 schema repair turns, one result reminder (tool
  transport, naming the missing `submit_<port>`) and one restart
  continuation; a result still missing fails the activation with
  `invalid-result`.
- **Progress.** `report_progress` (on nodes whose output type has items) adds
  provisional items the run view shows until the result is accepted.

#### Result slots

The `graph-output` result kind (`workflow-result-graph-output.ts`, item 103)
opens one result slot per output port, keyed uniquely across runs. The slot
carries the contract: the port type's schema, `toolName: submit_<port>` (with
`validate_<port>` for dry runs) and the port declaration as context (type,
choices, provenance). A submission goes through the type library's full
validation (budgets, schema, domain validator), the prose check of the result
kind the type maps to, provenance against the node's input items (`cite`, or
`accountForAll` with a `dropped` list; `validateGraphProvenance`), and
environment checks (`workspace-commit`, `file-list-paths`). A refused
submission returns correctable errors in the same turn; a slot that spends its
rejection budget becomes a repair turn, bounded by the runner. Providers on
structured output get one combined schema per activation
(`graphOutputCombinedSchema`), split back by port. On OpenCode, whose broker
has a fixed tool list, results go through the generic `submit_graph_output`.
Bridges learn per-port tool names per turn ([agent-engines.md](agent-engines.md)).

The activation's credential (`graph-agent-tools.ts`) reaches only its own
activation and carries only granted tools: the result tools,
`report_progress`, `read_artifact` (inputs rendered `on-demand`; at most 64
KiB of JSON, only artifacts the activation was given, verified before each
read), `ask_human` (opt-in) and the opted-in Orkestrator groups. A node with no
outputs gets no activation credential.

#### ask_human

A node with `askHuman: true` gets the `ask_human` tool (D15; at most 8
questions per activation, up to 8 choices). The call holds for up to 45 s for
an answer; otherwise the activation becomes `awaiting-human` (the run
`waiting`), the agent is told to end its turn, and the answer is sent as the
next turn once the asking turn has settled (`graph-agent-questions.ts`). Answers
arrive through `graph_run_answer {runId, activationKey, questionId, kind:
answered | declined, text?, choice?}` and are recorded under the run's lock.

### Gates, merges, loops and failure

- **Gates** (`graph-node-gate.ts`) try their branches in order with the
  three-valued evaluator and take the first true one, else `otherwise`; with
  neither, the gate completes with no outlet and every outlet's consumers
  skip. Untaken outlets' consumers skip, so a whole untaken
  subtree skips; a consumer with another live producer still runs.
- **Merges** (`graph-node-merge.ts`) are deterministic: `concat`, `dedupe`
  (items with the same key fold together, keeping every source id; D11's
  default fan-in), `vote` (majority over decisions, ties fail or take the
  first), `best` (by a score path) and `collect` (the list unchanged). Input
  order breaks every tie; failure markers are skipped except by `collect`; an
  empty input completes without an output, so consumers skip. At most 10,000
  items.
- **Collect policies** on fan-in ports (default `{wait: all-settled,
  minSuccessful: 1, includeFailures: true}`): `all-settled` waits for every branch;
  `quorum` delivers once `count` succeeded; `first` delivers the first `count`
  successes and cancels the rest when nothing else reads them. Fewer than
  `minSuccessful` possible successes fail the port. `includeFailures` adds each
  failed branch's `error@1` marker.
- **Loops** advance when every member of the iteration is settled and
  `until` (over `<member>.<port>`) is not true, up to `maxIterations`;
  `graphLoopState` derives why a loop is done (`converged`, `bound`,
  `not-entered`). Stopping at the bound is not a failure: consumers read the
  last iteration.
- **Failure.** The latest failed activation of a position is retried (a new
  attempt, the same inputs) while `retry.attempts` allow (default 1, no
  retry) and its cause is in `retry.on`. Then `onFailure`: `fail-run` (the
  default; replicated nodes default to `skip`, timed human nodes to `route`)
  fails the run and stops its other work; `skip` delivers
  nothing, so consumers skip; `route` stores an `error@1` artifact on the
  node's `error` port, whose consumers run while the other outputs' consumers
  skip. Causes (`GRAPH_ERROR_CAUSES`): `provider-error`, `invalid-result`,
  `timeout`, `guard-violation`, `budget-exceeded`, `system-error`.

### System nodes

System nodes (`graph-node-system.ts`, D12, D20) do every side effect in the
backend, so no agent pushes or writes to GitHub. Each action is one module
(`graph-system-*.ts`); its ports, parameters and `sideEffect` flag are
`GRAPH_SYSTEM_ACTION_SPECS` (`system-actions.ts`), which the compiler and the
designer read too.

`<slot>` below is the activation key without its attempt, so a retry or
restart of the same position reuses the key.

| Action | Does | Effect key |
| --- | --- | --- |
| `prepare-environment` | starts the environment (retrying every 60 s), runs setup when asked; outputs HEAD as `workspace@1` | `prepare-environment:<slot>` |
| `run-validation` | runs a `validation-plan@1` (plan, workspace and HEAD must agree) and reports `validation-results@1` without sealing | `run-validation:<slot>:validation:<digest>` |
| `run-validation-and-seal` | the same, then seals a `review-package@2` reference artifact | adds `:seal:<digest>` |
| `push-branch` | `git push origin <sha>:refs/heads/<branch>`; force with lease only once after a code rewind dropped upstream commits | `push:<branch>:<sha>` |
| `open-pull-request` | pushes, then adopts or opens the branch's PR with `gh` from a `pr-description@1` (reopens a closed one, a new one after a merge); reports `pr-result@1` and `pull-request-state@1` | the push key, `pr:<branch>` |
| `wait-for-checks` | reads the PR monitor (`timeoutMinutes`, default 60, at most 360); `passed`, `failed`, `pending` at the deadline, or `none` after 2 minutes without checks; reports `check-summary@1`. The only action without `sideEffect` | `wait-for-checks:<slot>` (holds the deadline) |
| `update-ticket` | moves the Kanban ticket, comments once, records a verdict's criteria, or applies one of the Build Pipeline's lifecycle updates, comparing state before each write | `update-ticket:<slot>` |
| `notify` | agent mail to the project's coordinator or a tab of the run's environment | `notify:<slot>` |
| `select-workspace` | fast-forwards the run's branch to the judged isolated branch ([below](#isolated-branch-worktrees)) | `select-workspace:<slot>:<sha>` |

`pull-request-state@1` is not built in: a template that reads it declares it
as a custom type (the Build Pipeline template does), and the compiler checks
the declaration accepts what the action produces (`graphPullRequestStateType`).

Every action but `wait-for-checks` runs as a background job: `start` launches
it and waits up to 2 s, a job still running reports `running`, and when it
settles it asks for an observation. `wait-for-checks` re-reads in-memory
monitor state and is woken by the PR monitor's events. **Idempotency** is the
effect journal's (`ctx.effect`, `graph-system-action.ts`): effects with one key
are serialized; an `intended` row is written before the effect and `done` (with
replay data) or `failed` after; a `done` row replays and never runs again; an
earlier `intended` or `failed` row is reclaimed, and a probe of the remote
state may settle it as done (the remote has the commit, the branch has an open
PR, HEAD is already the chosen commit); an abort leaves it `intended`, since
the outcome is unknown. So launching a job again after a crash, a lost save, a
retry or a node restart never repeats a recorded effect. Cancel aborts the job
and asks the action to stop work it left behind. A system node never uses an
agent session.

**Provisioning** (`GraphRunEnvironmentProvisioner`, `graph-system-prepare.ts`)
creates the environment a run without one needs: the kind from
`run.launch.create`, else the template's `workspace.create`; found or created
by `controlRequestId: graph-run:<runId>`, so a retried pass finds it; a
container gets the restricted network policy, a worktree is a local
environment. It links the launch's ticket and
returns the branch and HEAD for deferred `workspace@1` inputs.

### Human nodes

A person takes part at an explicit point (P2.8, D15). Shapes are in
`run-human.ts`; the executor in `graph-node-human.ts`.

- **Forms.** `approve` takes `approved` or `rejected`; `edit` does the same,
  and an approval may carry an edited value of the form's `edit` input;
  `choose` takes one option's outlet. A decided node forwards its single-value
  inputs as its outputs, as a gate does, with an edited value in place of the
  original.
- **The wait.** The executor's first call records `activation.human`
  (`GraphHumanWait {id, form, openedAt, answer?}`, a fresh UUID) and reports
  `awaiting-human`; the run is `waiting` when nothing else is admitted. The
  executor is observed only when woken (`observeAfterMs: null`) or at the
  deadline. The wait is in the run record, so it survives a backend restart
  and any view rehydrates it. A restart of the node supersedes the wait.
- **Answers.** `graph_run_answer {runId, activationKey, waitId, decision,
  outlet?, value?, note?}` goes to `GraphHumanAnswers`, which checks
  `graphHumanAnswerProblem` (the activation waits, the wait id is this
  attempt's, unanswered, the decision fits the form, note and value within
  bounds), stores an edited value as a new artifact of the original's type
  (lineage: the original; an unchanged value stores nothing), then records the
  answer under the run's lock, checking again, which wakes the run. A refused
  answer records nothing. `graph_run_pending {runId | environmentId}` lists
  every open wait and `ask_human` question (`GraphRunPendingInteraction[]`).
- **Timeouts.** Without `timeoutMs` the run waits indefinitely. With one, the
  node's default `onFailure` is `route` (`graphHumanRoutesFailures`), giving it
  an implicit `error` port of `error@1`; the timeout arrives as `cancel(…,
  "timeout")`, the planner routes the error and the outlets' consumers skip.
  An answer recorded before the deadline still wins.
- **Where a wait shows.** The run view (the face reads "waiting for you",
  `GraphHumanNodePanel`); the sidebar (`graph-run-attention.ts`: the
  environment's `graph-run` activity source is `working`, `waiting` or `idle`,
  and each new wait records one content-free attention key, lighting the
  unread badge with reason `agent_question` once); and the coordinator
  ([Launching](#launching)).

### Guards and enforcement

What a capability profile promises is either enforced by the provider or
detected by a guard, and the activation records which (P2.9, D4, D12;
`graph-agent-guards.ts`, `agent-enforcement.ts`).

- **The tier.** `graphAgentNodeEnforcement(compiled, platform, host)` judges a
  node with the shared matrix. The launch compile re-probes the host and
  returns `providerChoices`: per role, every enabled provider's weakest tier
  over the role's nodes and whether it meets each floor
  (`graphRoleProviderChoices`); `graphBindingFloorProblems` lists bound models
  that miss a floor.
- **At dispatch** the executor judges the node again on the live host
  (`defaultCoordinatorHostCapabilities`, whose Linux sandbox probe re-runs
  after its TTL). A tier that dropped fails the activation before any session
  with `guard-violation`. The applied tier, its reason and an `enforcement`
  guard result are recorded on the activation.
- **Read-only guard** (`read` and `none` nodes, and the run's checkout for an
  isolated branch): the generic guard from item 001
  (`workspace-read-only-guard.ts`). The baseline (HEAD, the uncommitted path
  set: digest, count, the paths when at most 64) is captured before dispatch
  and **fails closed** (invariant 8). An acceptance check on the activation's
  own `graph-output` slots refuses a submission with a correctable
  `worktree_changed` error so the agent can restore the tree in its turn. When
  the result is consumed, before any artifact is stored, the worktree is
  certified again; a change fails the activation and the evidence stays in its
  `guards`.
- **Remote-ref guard** (every agent node): before dispatch the run branch is
  read with `git ls-remote` on `origin` and the branch's upstream remote (every
  remote when neither exists; at most 8); unreachable remotes fail closed.
  After the turn their heads and tags are listed again; the guard fails the
  activation when the run branch moved or any ref points at a commit the
  activation created (in `baseline..HEAD` or the HEAD reflog since the
  capture). Pushes by the run's own system nodes are not counted. It cannot
  see a push to an unwatched remote or URL, a push of older commits, or GitHub
  writes that are not pushes.
- **GitHub credential.** Graph agent policies deny `github.write`, and the
  session runs without the GitHub credential where the provider allows it
  (`NATIVE_AGENT_GITHUB_CREDENTIAL_WITHHOLDING`; mechanisms in
  [agent engines](agent-engines.md)):

  | Provider | Withheld from | Still holds it |
  | --- | --- | --- |
  | Claude | the CLI process of every query | the bridge process |
  | Grok | the session's ACP child | the bridge process |
  | Codex | every command the thread runs (per-thread `shell_environment_policy`) | the shared app-server process; a stdio MCP server whose entry names the variable |
  | Pi | the session's `bash`/`powershell` and the MCP servers the bridge starts | the bridge process and the Pi extensions running in it (project resources on); a credential written literally into an `mcp.json` entry |
  | OpenCode | nothing: one `opencode serve` per directory | every session |
  | Cursor | nothing: the SDK runs in the bridge process | every session |

  Everywhere, SSH keys, a container's runtime credential file and Git's
  `insteadOf` rewrite stay readable, and a command can read an ancestor
  process's environment. The remote axis therefore stays advisory on every
  provider; its reason names the withheld credential only where it is
  withheld and states the gap otherwise.
- **The inspector** reads `activation.enforcement`, `enforcementReason` and
  `guards` (`graphActivationEnforcementView`, `GRAPH_GUARD_LABELS`).

### Isolated branch worktrees

A way for several branches to write at once, each in a workspace of its own
("three competing implementations, a judge picks one", report §6.7, §9.3).
Design note:
[`plans/graphs/403-isolated-branch-worktrees.md`](../../plans/graphs/403-isolated-branch-worktrees.md).

- **Opting in.** `isolation: "worktree"` on a replicated writer with exactly
  one single `workspace@1` input and at most 8 branches (`isolation-*` codes).
  For the workspace rules an isolated writer *reads* the run's workspace
  (`graphMainWorkspaceAccess`).
- **One worktree per branch.** Before the guards' baseline the agent executor
  creates the branch's worktree (`GraphBranchWorktrees.create`, `git worktree
  add -B`) from the commit its `workspace@1` input names, at
  `.orkestrator/graph-branches/<run>/<node>/i<iteration>/<branch>` on branch
  `orkestrator-graph/<run>/<node>/i<iteration>/<branch>`. Git runs at the
  environment root through the environment command runner (in a container
  through `docker exec -w /workspace`). The activation records it
  (`NodeActivation.worktree`); a later attempt gets a fresh one from the same
  commit.
- **Confinement is guarded, not enforced.** Bridges have one working directory
  per process, so a branch's session runs in the environment's bridge with a
  locked prompt frame (`graphBranchWorktreeInstruction`) naming its worktree.
  The run's checkout gets the read-only guard for the whole turn; the
  `worktree` guard certifies the branch's worktree (present, on its branch,
  descending from its base, nothing uncommitted); the remote-ref guard reads
  the branch's commits. The branch's `workspace@1` output is its worktree's
  HEAD; `push-branch` and `open-pull-request` refuse it.
- **Locks.** A branch holds a reader on the run's workspace and is the one
  writer of its worktree; at most 16 branch worktrees are admitted per
  environment (`worktree-limit`).
- **`select-workspace`** takes the candidates (`list<workspace@1>`) and a
  `decision@1` whose `choice` names the winner by branch key, its last part, or
  Git branch (`resolveGraphSelectChoice`; `fallback: "first"` optional). With
  the run's checkout on its branch and free of tracked changes it
  fast-forwards the branch to the chosen commit (effect
  `select-workspace:<slot>:<sha>`), then removes every candidate's worktree and
  branch. A person picks by putting a human `edit` node on the decision. An
  ordinary builder can instead merge the branches with Git.
- **Cleanup.** `GraphBranchWorktreeJanitor` removes the worktree of every
  terminal isolated activation after each saved record (unless a newer live
  attempt recorded its own), removes the run's branches when it ends, sweeps
  at start-up, and environment deletion removes them first
  (`removeEnvironmentGraphBranchWorktrees`). Removal never follows a link.
  `mise run disk:report` counts them ([disk-usage.md](../development/disk-usage.md)).
- A code rewind of an isolated activation is refused (its restart already
  starts from its input). `graphCompetingImplementationsTemplate()` is the
  reference graph.

### Restart and rewind

`graph-run-rewind.ts` (P2.10, D8).

- **Restart** an activation: it, every activation that transitively consumed
  its artifacts or read its position (gate consumers, skipped nodes, later loop
  iterations) and those artifacts are superseded, in one compare-and-swap save
  (`graphRestartScope`, `applyGraphRewind`, `saveGraphRun(…, {supersede})`).
  Admitted activations in that set are cancelled first (`restarted`). The next
  pass recreates the superseded positions with the next attempt: the node
  reruns on the same inputs with a fresh session; inside a loop the counter
  rewinds to the node's iteration. Independent branches are kept. A restarted
  branch keeps its branch key and item ids.
- **Code rewind** resets the worktree to the commit of the node's input
  `workspace@1`, then restarts the node. It reuses the pipeline's Git side
  (`workspace-code-rewind.ts`: preview, refusals, backup ref, reset). The
  rewind is journaled (`GraphRewind.code {headRef, from, backupRef, upstream,
  upstreamCommitsDropped, pending}`) before Git changes, so the next push
  forces with lease once (`graphForcePushRewind`) and a crash between the save
  and the reset is finished before the run plans again. It needs a quiet
  workspace: the run paused or finished, nothing admitted, no other writer on
  the environment, a clean worktree at the HEAD the preview showed, a target
  that is an ancestor of HEAD, and no commit of a node outside the restart
  among those dropped.
- **Rules.** A repeated request (same `requestId`, or a double click) is a
  no-op. A live or paused run restarts and runs; a finished run reopens to
  `running`; `provisioning` and `cancelling` refuse. Both refuse once the run's
  PR merged and after 50 rewinds. A mock run never changes code.
- **Commands** `graph_run_restart`, `graph_run_rewind_code_preview`,
  `graph_run_rewind_code`; blockers `graphRunRestartBlocker` and
  `graphRunCodeRewindBlocker` (`run-rewind.ts`) drive the UI.
  `graph_run_retry` (the latest failed attempt of a live run) records a user
  `restart` rewind over its lineage descendants and the never-started markers
  behind it, without cancelling other work or reopening the run;
  `graph_run_skip` settles a waiting or ready position as skipped.

### Mock runs

A mock run tests a graph's control flow for free (report §7.5): the same
scheduler as a real run (admission, retries, `onFailure`, loops, the record's
bounds; gates and merges are the live executors), but agent, system and human
nodes are answered by mock executors (`graph-mock-provider.ts`). `GraphRun.mock`
is true and `GraphRun.mockOptions` freezes the effective pins and step delay.

- **Answers.** Each output port takes the activation's pin, else the type's
  `example`, else a value generated from its schema (`graphSchemaSample`,
  deterministic over the subset). `graphMockValue` fits built-in values to the
  port (a decision's `choices`, the ticket's criterion ids, the run's commit
  for `headRef`). Values go through the artifact store, so they pass the same
  validation as real ones; a pinned value that does not fails with
  `invalid-result`.
- **Agents** create no session, report no tokens and run no guards; a writing
  agent's `workspace@1` is a fake commit (`graphMockWorkspace`). A mock agent
  never asks a question.
- **System nodes** never run a handler: `workspace@1` passes through,
  `review-package@2` is an unwritten mock file, `pr-result@1` says no PR was
  opened, `wait-for-checks` answers at once. An action with `sideEffect`
  records "would have run" in the effect journal (state `simulated`, key
  `would-run:<activation key>`, data `{wouldRun}`: action, parameters, facts
  such as branch, commit, ticket move or recipient).
- **Human nodes** answer by themselves (approve; an `edit` forwards unedited;
  a `choose` takes its first option). A pin takes another outlet or `pause`s:
  the activation goes to the live human executor and waits for a person.
- **Pins** (`GraphMockPins`: node id → sequence). The *n*-th activation of a
  node's branch takes the *n*-th pin; the last repeats. A pin is `"example"`,
  `"generated"`, `{outputs: {port: value | null}}`, `{fail: cause, message?}`,
  or for human nodes `{outlet, outputs?}` and `"pause"`. Pins are stored on
  the template (`mockPins`, outside the digest) and a launch's `pins` replace
  them node by node; `graphMockPinIssues` checks them (`mock-pin-*` codes).
  Keys are plan node ids, so a pin may target a node inlined from a sub-graph.
- **Launching.** `graph_run_mock {ref, projectId, environmentId?, inputs?,
  params?, roles?, pins?, panel?, stepMs?}` (`graph-mock-launch.ts`) compiles
  the stored template under the ceiling; compile errors and built-ins are
  refused, trust and acknowledgements are not needed. Unbound roles get
  placeholders, missing inputs their type's example. Without `environmentId`
  the run is environment-less (listed by id only); with one it is listed and
  removed with that environment, and still touches nothing. `stepMs` (0–10 s)
  makes each mock activation report `running` that long first. Each
  environment-less launch keeps the newest 20 finished environment-less mock
  runs of the project; orphans are swept at startup.

## Launching

Every entry point launches through one service, `GraphRunLaunchService`
(`graph-run-launch.ts`), with the request shape in `launch.ts`
(`GraphLaunchRequest`: `ref`, `projectId`, `environment` (`{kind: "existing",
environmentId}` or `{kind: "new", create: "worktree" | "container"}`), `roles?`, `params?`, `inputs?`,
`ticket?`, `saveDefaults?`, `requestId?`). The surface supplies the origin
(`requestedBy` and `scheduleId`); a request body can never claim one.

1. **Resolve and compile.** `GraphTemplateService.compileForLaunch(ref,
   projectId, environment)` refuses an untrusted or changed project template
   (`untrusted`), a built-in on its own engine (`engine-template`) and any
   unsaved draft (the request names a stored `ref` only). The template is
   compiled under the **real** launch environment's execution policy (an
   existing environment's own, or what a new worktree or container gets) and
   the project's ceiling; compile errors or pending acknowledgements are
   `not-launchable`.
2. **Bind roles.** The request's binding, else the defaults saved for this
   template in this project (while their providers are enabled and the shape
   fits), else the Settings defaults (`graphRoleDefaultBindings`: a one-model
   role takes the first `defaultsFrom` key with a usable saved platform, else
   the default agent; a panel takes one position per key, then one per
   `additionalReviewers` entry, with the saved reviewer lenses). A panel member
   may carry a `lens` (P0.5); a template lens axis wins over it.
3. **Check bindings** (`invalid-binding`): enabled, meets every bound node's
   floor on this host (the same judgement dispatch re-checks), and can return
   the role's typed results.
4. **Parameters and inputs** (`invalid-launch`): given, else saved, else
   default, each checked. Run inputs are value types. `ticket: {taskId,
   input?}` fills the template's `ticket@1` input from the Kanban ticket. An
   empty `workspace@1` input is filled from the environment's branch and HEAD,
   at launch or by the provisioner.
5. **Create.** `GraphRunService.create` on an existing environment, or with
   none for a new one (D7; the provisioner creates it). The ticket is linked to
   the run's environment; a mock run never links.

`requestId` derives the run id (`launch-<sha256(project, key)>`), so a repeat
returns the run it created (`repeated: true`) and a repeat with a different
template or environment is `conflict`. Refusal codes are
`GRAPH_LAUNCH_ERROR_CODES` (`invalid-request`, `not-found`, `untrusted`,
`engine-template`, `not-launchable`, `invalid-binding`, `invalid-launch`,
`conflict`, `disabled`), the same on every surface. `saveDefaults: true`
stores roles, parameters and environment kind per template per project
(`launchDefaults`, at most 64 per project). A run that fails before it has an
environment is kept by `sweep()` only up to 20 per project and 7 days.

**Commands.** `graph_launch_options {ref, projectId, environmentId?, create?}`
returns `GraphLaunchOptions` (per role every enabled provider with its tier,
`available` and `unavailableReason`; parameters; inputs; the cost; saved
defaults). `graph_run_launch` launches as `user`.

**Surfaces:**

- **The launch dialog** (`components/graph-launch/GraphLaunchDialog.tsx`),
  generated from `GraphLaunchOptions`: inputs (a `ticket@1` input takes a
  Kanban ticket), a picker per role offering only `available` providers and
  showing why the rest are not, panel editors with a lens per member,
  parameters, the environment choice and the cost estimate. It starts from the
  saved defaults and launches with `saveDefaults: true`. Entry points (D17):
  "Run graph…" in the environment action bar (`RunGraphButton`), "Run graph…"
  on a Kanban card, and "Run" in the designer header (a dirty draft is saved
  first). After a launch `openLaunchedGraphRun` asks for the run's tab through
  `requestGraphRunView` (`lib/graph-run-navigation.ts`); the environment's
  terminal container answers it, and a request for an environment that is
  off screen waits until it is shown.
- **The CLI**: `orkestrator graph list | show | validate | launch | status |
  cancel` over the `graph.*` public actions
  ([public-cli.md](public-cli.md#graphs)), launched as `cli` with a `requestId`
  derived from the public request key.
- **The coordinator** (D6): Control MCP `list_graph_templates`, `launch_graph`,
  `get_graph_run` and `cancel_graph_run` (`control-mcp-graph-tools.ts`,
  `coordinator-graph-actions.ts`), launched as `coordinator`. No tool creates,
  saves, edits, duplicates, imports or describes a template. A launch reserves
  a `graph-run` workflow association before it acts; the status wake
  (`graph-run-coordinator-status.ts`, observed by `coordinator-status-wakes.ts`)
  sends one notice per wait for a person and one when the run ends
  ([coordinator.md](coordinator.md)).
- **Schedules**: a `graph` schedule action holds a launch request, validated
  when the schedule is created, and fires as `schedule` with `requestId`
  `sched:<fireId>`, so a replayed fire finds its run
  ([scheduled-jobs.md](scheduled-jobs.md)). It is created and edited in
  Settings → Schedules ("Run a graph": template, environment, inputs, and
  either the saved launch defaults at fire time or pinned roles and
  parameters; `ScheduleGraphFields.tsx`, `graph-schedule-model.ts`) and by
  `orkestrator schedule create|update --graph TEMPLATE` with the flags of
  `graph launch` ([public-cli.md](public-cli.md#graphs)).

## Describe a graph

The user writes what the graph should do and picks a model (optionally
"Modify the current draft"); a designer agent drafts the template, which opens
in the designer **unsaved** and runs only after the user saves it (item 215).

- **The job is the backend's.** `graph_describe_start {environmentId,
  description, agent, model?, reasoningEffort?, fastMode?, baseDraft?}` stores
  one job per environment (`graph-describe` store) and returns at once.
  `GraphDescribeService` advances it on its own timer and resumes running jobs
  after a restart. The web reads it with `graph_describe_status` on mount, on
  `graph-describe` change hints and on view safety checks;
  `graph_describe_cancel` and `graph_describe_dismiss` end it. It needs a
  running environment and an agent the result-tool rollout admits for
  `graph-template`.
- **The session.** One unattended, read-only branch of the shared agent branch
  runner (`graph-describe-host.ts`) with the environment's `automated-review`
  policy. The prompt (`renderGraphDescribePrompt`) explains the model from the
  live registries (node kinds, types, built-in prompts, system actions,
  predicates, loops, replicate, profiles, bounds), quotes the §9 examples that
  compile (at most 16 KiB), and frames the draft and description as evidence.
- **The result kind.** `graph-template` (`submit_graph_template`). Its schema
  (`graphTemplateJsonSchema()`) is a tool-transport schema: the template does
  not fit the strict structured-output subset, so the schema guides and the
  authority is `graphTemplateResultIssues`: the guard's errors, no
  `acknowledgements` or `engine`, then the compiler's errors under the user's
  enabled providers and the project ceiling. Warnings are left to the user. A
  refused submission returns `{code, path, message}` problems for correction in
  the same turn (rejection budget 4), then repair turns (at most 3).
- **Opening the draft.** The first active designer tab that sees the completed
  job opens it with `openDraft` (asking first over unsaved edits) and
  dismisses the job; an inactive tab opens it when shown.
- **Not for the coordinator (D6).** The `graph_describe_*` commands are app
  commands, not public actions (`graph-describe-coordinator.test.ts`).

## The designer

### Canvas library decision (spike, 2026-10-29)

**Decision:** the designer uses React Flow (`@xyflow/react`), pinned exactly at
`12.12.0` (MIT). The run view stays on `components/flow-graph/`. Revisit 13.x
when stable (it uses zustand 5, removing the duplicate zustand 4 copy).

Evidence (100 nodes, 153 edges, headless Chromium, production bundle): mount
49–60 ms (in-house 37–57 ms); 4× CPU throttle 139–150 ms (in-house 153–164
ms); node drag about 0.85 ms script per pointer step, no frame over 16.8 ms.
Bundle: +58.6 KB gzip JS and +3.0 KB gzip CSS, so the designer tab is
lazy-loaded. Editing in-house would have meant rewriting the viewport (drag,
hit-testing, connection drag, selection, groups, unbounded canvas, minimap).
Against the P1.10 criteria: per-node `ariaRole`, `ariaLabel` and
`domAttributes.tabIndex` keep the flow-graph keyboard pattern; styles are
scoped to `.react-flow*` with `--xy-*` variables; loop regions are `type:
"group"` nodes with `parentId` and `extent: "parent"`.

Integration notes: `@import "@xyflow/react/dist/style.css" layer(base);` after
Tailwind in `apps/web/src/index.css`, tokens mapped on `.react-flow`,
`colorMode="dark"` with the app; `proOptions={{ hideAttribution: true }}`;
handles `in:<port>` / `out:<port>` carrying the type family; parents before
children; `edgesFocusable={false}` with edges listed in the inspector; our own
undo stack; tests stub `ResizeObserver`, `DOMMatrixReadOnly` and element sizes
under happy-dom; do not wrap the canvas in `<Activity>` (upstream #6044).

### Opening, state and compiling

The environment action bar's **Graphs** button calls
`createTab("graph-designer")`; there is one designer tab per environment
(`openGraphDesignerTab`). The pane layout keeps only
`TabInfo.graphDesignerData = {selected?: GraphTemplateRef}`; everything else is
a backend snapshot in `stores/graphDesignerStore.ts` (`libraries` per project
from `graph_templates_list`, `tabs` per tab: the template, its compile with the
plan, selection and the editor), re-read on mount, on `graph-template`
resource changes and on view safety checks, with stale responses dropped by a
per-tab request sequence.

A stored template is compiled by the backend under the project's ceiling,
enabled providers and probed host. A draft is compiled in the browser with the
same `compile()` 250 ms after the last edit, with the ceiling from the library
result and the enabled providers from settings; the host is the conservative
default (no Claude command sandbox).

### Panels

- `GraphLibraryList`: built-in, user ("Yours") and project sections, compile
  counts, a built-in's engine (retired marked), project trust with Approve and
  Revoke, the project directory's problems, and the environment's runs
  (`GraphRunsList`).
- `GraphCanvas` and `GraphCanvasNodes`: the projection
  `buildGraphCanvasModel({template, plan, diagnostics})`
  (`graph-designer-model.ts`): faces with title, role and profile, an
  enforcement-floor badge and a replication badge; handles coloured by
  `graphTypeFamily`; run inputs and outputs as `$inputs`/`$outputs`
  pseudo-nodes; each loop a group ("↻ ≤ N"); carries as dashed edges.
  Positions come from `template.layout` when it places every node, else from
  `layoutGraphTemplate`. Nodes and edges with errors are marked. One tab stop;
  arrows and Home/End move in topological order.
- `GraphInspector`: the template summary, or the selected node (compiled
  capabilities and the per-provider matrix), edge or loop.
- `GraphCompilePanel`: counts, the cost estimate, every diagnostic (one that
  names a node, edge or loop selects it) and pending acknowledgements.
- Import (`graph_template_import`), Export and Copy JSON
  (`graph_template_export`), Duplicate, Share…, Import bundle…, Review (N)
  (`GraphShareDialogs.tsx`, `GraphTemplateReviewPanel.tsx`), Describe a graph,
  Mock run and Run.

### Editing

**The editor.** "Edit" (or "Edit as JSON") on a user template calls
`openEditor`; **New graph** opens `blankGraphTemplate()`. The tab's `editor`
holds the structured `draft`, `saved`, `baseRevision`, `isNew` and the
history. Every change is one store call, `edit(tabId, label, recipe,
{coalesce})`, with `recipe` a pure function over the template
(`graph-designer-edits.ts`, `graph-designer-connect.ts`). The history keeps at
most 100 steps; same-key edits within 1.5 s coalesce. Undo and redo are on the
editing bar and Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z, Ctrl+Y (outside text fields);
Ctrl/Cmd+S saves. Leaving unsaved edits asks first; a never-saved draft lives
only in the store.

**Canvas editing** (`useGraphDesignerEditing`):

- *Palette* (`GraphPalette`): Agent, System (the actions from
  `GRAPH_SYSTEM_ACTION_SPECS`, side effects marked; Select branch for item
  403), Gate, Merge, Human, Loop region (wraps the selected node) and Sub-graph
  (saved templates; never the one being edited; untrusted ones disabled; read
  first and pinned to its digest and revision).
- *Connecting.* `graphConnectionVerdict(template, library, from, to)` decides
  what a connection becomes using `graphTypeAssignability` on the delivered
  type: an edge, a `zip` edge between nodes replicated the same way, a loop
  carry when it would close a cycle inside one loop (a cycle outside is
  refused); one value into a list port is refused. While dragging, compatible
  handles light up and the rest refuse the drop, with a hint. The `+` handle
  adds a port of the delivered type. A second producer drawn into a loop
  member from outside sets `firstIterationFrom`.
- *Fan-in default (D11).* A replicated producer drawn into a single-value port
  inserts a `dedupe` merge when the element type declares `items` (key
  `file`, `line`, `title` when present, else `id`), with a notice and one undo
  step; otherwise the port becomes `list<T>`.
- *Moving* writes absolute positions for every node to `template.layout`;
  dropping a node on a loop frame moves it in, dragging it off takes it out;
  **Arrange** lays everything out. *Deleting* keeps references consistent.
  *Keyboard*: C ("Connect to…", `GraphConnectDialog`), L ("Loop…",
  `GraphLoopDialog`), Shift+arrows move 20 px.

**Inspector forms** (`GraphEditorContext`, `graph-form-controls.tsx`): the
template form (`GraphTemplateEditor`: id for new drafts, name, workspace,
limits, parameters, roles, run inputs and outputs, custom types,
acknowledgements on record); agent nodes (`GraphNodeEditor`: Prompt,
Inputs/Outputs, Capabilities with the MCP servers editor, Isolation and
`GraphEnforcementMatrix`, Execution with replication, session, `ask_human`,
retry, timeout, on-failure and `when`, and a Mock run tab); system nodes (the
action spec and a typed params form, `GraphSystemParamsEditor`); gates with
`GraphPredicateEditor` (path suggestions from the input schemas, live type
check, JSON fallback); merges, human forms, sub-graphs (`GraphSubgraphEditor`:
the pin, parameter and role bindings, the plan nodes it became); edges and
loops.

**Prompt editor.** `{{` completes what the node can read
(`graph-designer-prompt.ts`). The preview is `renderGraphNodePrompt` with
`preview: true` over each input type's `example` or a pasted fixture: the user
part and, below it, the locked system contract. Size is checked against the
160 KiB ceiling; lints link to their line and column.

**Type editor.** `GraphTypesEditor` and `GraphSchemaEditor` build schemas
within the subset (every property required, "may be null" as `anyOf` with
null, closed objects, enums, bounds, nested objects and arrays,
`x-orkestrator-sources`), with a JSON fallback, "Schema from example" and live
checks. Renaming a type rewrites every port that names it.

**Acknowledgements.** The compile panel's Acknowledge records `{kind, digest,
acknowledgedAt, code}` in the draft (`acknowledgeGraphWarning`); a change that
alters the warning needs a new one, and stale ones are flagged.

**Saving.** `saveDraft` refuses a draft the guard refuses, then calls
`graph_template_save` with `expectedRevision`. A `revision-conflict` keeps the
draft and offers **Save as copy** (an import as `<id>-copy`) and **Reload
latest**; a stored template that moved on is flagged before Save is tried.
Compile errors do not block a save, only a launch.

**Tests.** Component and store tests beside the code (React Flow stubs in
`react-flow.test-support.ts`, `renderWithGraphEditor` for forms; a drag in
happy-dom must not be wrapped in `act()`). Real-stack specs (browser suite):
`e2e/agent-testing/graph-designer.spec.ts`, `graph-designer-editing.spec.ts`,
`graph-designer-mock.spec.ts` and `graph-run-view.spec.ts`.

## The run view

**Opening it.** A `graph-run` tab shows one run; there is one tab per run
(`openGraphRunTab`). It opens from the designer's runs list, after a launch or
a mock run (`requestGraphRunView`), or from a link. The pane layout keeps only
`TabInfo.graphRunData = {runId, title?}`; the component is lazy-loaded.

**Reads and rehydration** (invariant 1). Commands, with shapes in `run-view.ts`:

| Command | Arguments | Result |
| --- | --- | --- |
| `graph_runs_list` | `{environmentId}` | `GraphRunSummary[]`, newest first, at most 200 |
| `graph_run_get` | `{runId, knownRevision?}` | `{status: "changed", run}` or `{status: "unchanged", revision}` |
| `graph_run_cancel`, `graph_run_pause`, `graph_run_resume` | `{runId}` | `{status: "changed", run}` |
| `graph_run_retry`, `graph_run_skip` | `{runId, activationKey}` | `{status: "changed", run}` |
| `graph_run_artifact` | `{runId, artifactId}` | the envelope; the value inline up to 512 KiB, else `valueOmitted: "too-large"`; a reference artifact's metadata, never the file |
| `graph_run_transcript` | `{runId, activationKey, fromIndex?, maxBytes?}` | one window (default 2 MiB, at most 4 MiB) of the stored transcript, or `none` |
| `graph_run_answer` | an `ask_human` answer (`questionId`, `kind`, `text?`, `choice?`) or, with `waitId`, a human-node answer ([above](#human-nodes)) | `{activationKey, question}` or `{activationKey, human}` |
| `graph_run_pending` | `{runId}` or `{environmentId}` | every open wait and question |
| `graph_run_restart`, `graph_run_rewind_code_preview`, `graph_run_rewind_code` | [Restart and rewind](#restart-and-rewind) | |

Refusals throw `GraphRunServiceError` (`invalid-request`, `not-found`,
`invalid-state`, `disabled`). Snapshots go through `graphRunViewSnapshot`,
which drops the runtime's own repair and continuation prompts.
`stores/graphRunStore.ts` re-reads a run on mount, when the tab becomes active,
on `graph-run` resource changes naming it, on resyncs and on view safety
checks, passing its revision; it applies only newer snapshots, coalesces
bursts (one read in flight plus one after it), keeps the last snapshot when a
refresh fails, and shows a deleted run as gone. Unmounting sends nothing.
Artifacts (200) and transcripts (32 activations) are cached.

**Projection.** `graphRunFlowModel(plan, run)` (`graph-run-flow.ts`) feeds the
shared `FlowGraph` (D16) with the build pipeline's column layout. A flow node
is a position (node, loop iteration, branch), the run's inputs, or a previous
attempt. Branches share a column (an `items` node is one placeholder until it
expands, then one position per item, with "N of M items run; K truncated");
loop iterations unroll to the right. Positions not reached are faded. A gate
or human node shows the outlet it took and the rest stay pending; nodes behind
them show as skipped. An `awaiting-human` activation is highlighted "waiting
for you", with a banner, and selected by default. Activations a rewind
superseded collapse into one "Previous attempt" node per rewind, expandable.

**Inspector** (`GraphRunInspector`): the `ask_human` question with
`GraphQuestionAnswerForm` (choices, free text, decline), the human node's
`GraphHumanNodePanel` (Approve/Reject or options, a note; for `edit`,
`GraphArtifactValueEditor` checked live), the error and cause, profile,
applied tier and reason, sandbox policy and turn mode, guard results, the
session's agent, tokens and times, provisional progress, the branch's
worktree, and the artifacts rendered by type (a built-in formatter, else the
type's markdown, else its summary fields, else JSON). The Transcript view
renders the stored transcript with the build pipeline's stack.

**Transcripts.** `graph-run-transcripts.ts` stores each activation's provider
messages in the build pipeline's content-addressed transcript store (owner
`graph-run:<run id>`, one session per activation key) when a turn settles and
at most every 15 s while it runs, only when changed, never failing the
activation. Deleting a run with its environment deletes its transcripts.

**Actions** (`graph-run-actions.ts`, on face context menus and in the
inspector): Retry, Restart from here, Rewind code to here… (disabled with the
blocker's reason, such as "Pause the run first"; a preview dialog confirms the
HEAD it showed), Skip, Open session (the provider session in a native tab that
refuses to start a fresh one), and Pause, Resume and Cancel. Mock runs are
labelled "Mock run".

## Multi Review on the graph runtime (item 301)

Not in this tree yet. Item 301 runs the built-in Multi Review template on the
graph runtime behind a setting and adds its section here.

## Bounds

Every bound below is enforced by a guard or the runtime, not only documented
(invariant 6). **P** is `packages/protocol/src/graphs/`, **B**
`apps/backend/src/core/`, **W** `apps/web/src/`.

**Template** (`GRAPH_TEMPLATE_BOUNDS`, P`grammar.ts`):

| Bound | Value |
| --- | --- |
| `maxTemplateBytes`, `maxTemplateDepth` | 1 MiB, 48 |
| `maxIdChars`, `maxKeyChars`, `maxTypeRefChars`, `maxPathChars`/`maxPathSegments` | 64, 48, 96, 256/16 |
| `maxNameBytes`, `maxLabelBytes`, `maxDescriptionBytes`, `maxPortDescriptionBytes` | 200 B, 200 B, 4 KiB, 2 KiB |
| `maxParameters`, `maxEnumOptions`, `maxStringParameterBytes`, `maxNumberAbs` | 32, 32, 4 KiB, 1e12 |
| `maxRoles`, `maxDefaultsFrom`, `maxTypes`, `maxRunInputs`, `maxRunOutputs` | 16, 8, 32, 16, 16 |
| `maxNodes`, `maxEdges`, `maxLoops`, `maxLoopCarry`, `maxPortsPerDirection` | 100, 400, 16, 16, 16 |
| `maxGateBranches`, `maxChooseOptions`, `maxCapabilityOverrides` | 16, 16, 32 |
| `maxSystemParams`, `maxSystemParamListItems`, `maxSystemParamStringBytes` | 16, 32, 2 KiB |
| `maxSubgraphParamBindings`, `maxSubgraphRoleBindings` | 32, 16 |
| `maxTransformsPerEdge`, `maxPickFields`, `maxTransformLimit`, `maxMergeKeyPaths` | 8, 32, 1000, 8 |
| `maxAcknowledgements`, `maxAcknowledgementNoteBytes`, `maxLayoutCoordinateAbs` | 64, 1 KiB, 1,000,000 |
| `maxBranches` (= `REVIEW_FANOUT_MAX_REVIEWERS`), `maxReplicateAxes` | 32, 3 |
| `maxLensLabelChars`, `maxLensInstructionBytes` | 64, 4 KiB |
| `maxRetryAttempts`, `minTimeoutMs`–`maxTimeoutMs` | 5, 1 s–7 days |
| `maxLoopIterations` (= `MAX_BUILD_PIPELINE_ITERATIONS`) | 10 |
| `maxAgentSessions`, `maxConcurrentAgents`, `maxTokens`, `maxWallClockMs` | 200, 32, 1e9, 7 days |
| `maxPromptTemplateBytes`, `maxHumanInstructionsBytes` | 32 KiB, 4 KiB |
| `maxTypeVersion`, `maxListDepth`, `maxTypeSchemaBytes`/`Depth` | 999, 2, 64 KiB/32 |
| `maxTypeExampleBytes`, `maxTypeMarkdownBytes`, `maxTypeSummaryFields`, `maxTypeSharedFields`, `maxItemIdPrefixChars` | 64 KiB, 16 KiB, 16, 16, 32 |
| `maxValueArtifactBytes` (= `WORKFLOW_RESULT_MAX_BYTES`), `maxReferenceArtifactBytes`, `maxArtifactItems` | 384 KiB, 32 MiB, 10,000 |
| `maxPredicateDepth`, `maxPredicateNodes`, `maxPredicateListValues`, `maxPredicateStringBytes` | 8, 64, 64, 1 KiB |

**Model, compiler and prompts:**

| Bound | Value | Where |
| --- | --- | --- |
| `GRAPH_PLAN_BOUNDS` nodes/edges/loops; `GRAPH_PLAN_ID_MAX_CHARS` | 400/1600/64; 128 | P`grammar.ts` |
| `GRAPH_TEMPLATE_MAX_ERRORS` | 50 | P`template.ts` |
| `GRAPH_SUBGRAPH_MAX_DEPTH`, `GRAPH_SUBGRAPH_MAX_RESOLUTIONS` | 4, 64 | P`subgraphs.ts` |
| `GRAPH_CAPABILITY_CEILING_MAX_ENTRIES` | 64 | P`capability-profiles.ts` |
| `GRAPH_SCHEMA_SUBSET_BOUNDS`: schema bytes/depth, object depth, properties per object/total, enum values per enum/total, enum string, `anyOf` branches, sources fields | 64 KiB/32, 10, 100/1000, 256/1000, 256 B, 8, 16 | P`schema-subset.ts` |
| Built-in type budgets (`maxBytes`) | text 64 KiB, markdown 128 KiB, ticket 256 KiB, workspace 4 KiB, validation-plan 24,000 B, review-package 16 MiB, decision 16 KiB, error 16 KiB, reports 384 KiB | P`types.ts` |
| `GRAPH_PREDICATE_MAX_UNKNOWN_PATHS` | 8 | P`predicate-eval.ts` |
| `GRAPH_PROMPT_TEMPLATE_LIMITS` bytes/depth/sections/tags/name/segments | 64 KiB/8/256/2048/256/16 | P`prompt-template.ts` |
| `GRAPH_PROMPT_RENDER_LIMITS` output/iterations; `GRAPH_PROMPT_MAX_DIAGNOSTICS` | 8 MiB/100,000; 64 | P`prompt-template.ts` |
| `GRAPH_PROMPT_INPUT_CEILING_BYTES` | 160 KiB | P`prompt-size.ts` |
| `GRAPH_COMPILE_MAX_DIAGNOSTICS` | 500 | P`compile-diagnostics.ts` |
| `COMPILE_CACHE_ENTRIES` | 256 | B`graph-template-service.ts` |

**Run record and artifacts** (`GRAPH_RUN_BOUNDS`, `GRAPH_ARTIFACT_BUDGETS`, P`run-model.ts`):

| Bound | Value |
| --- | --- |
| `maxActivations` (live), `maxActivationHistory`, `maxRewinds`, `maxAttempt` | 200, 2,000, 50, 1,000 |
| `maxRecordBytes` | 16 MiB |
| `maxErrorChars`, `maxGuardResults`, `maxGuardDetailChars`, `maxGuardPaths` | 2,000, 8, 512, 32 |
| `maxBaselinePaths`, `maxBaselineUpstreamRefs` | 64, 8 |
| `maxPorts`, `maxPortArtifacts`, `maxRoleBindings`, `maxPanelBindings`, `maxParams`, `maxInputs` | 16, 256, 16, 32, 32, 16 |
| `maxLoops`, `maxIteration`, `maxFanOuts`, `maxTruncatedItemIds` | 64, 10, 500, 32 |
| `maxInlineBytesPerRun`, `maxDiskBytesPerRun`, `maxArtifactsPerRun` | 32 MiB, 256 MiB, 8,192 |
| `maxValueBytes`, `maxReferenceBytes`, artifact lineage `maxInputs`, `maxItemIds`/`maxItemIdChars` | 384 KiB, 32 MiB, 256, 10,000/128 |
| Effect key, effect data (B`storage-graph-effects.ts`) | 512 chars, 64 KiB |

**Runtime** (B unless noted):

| Bound | Value | Where |
| --- | --- | --- |
| `MAX_CONCURRENT_GRAPH_RUN_PASSES`; supervisor discovery | 8; 30 s | `graph-run-supervisor.ts`, `workflow-supervisor.ts` |
| `GRAPH_RUN_OBSERVATION_MS`, `GRAPH_RUN_PROGRESS_MS`, `GRAPH_RUN_HUMAN_WAIT_MS` | 3 s, 1 s, 30 s | `graph-run-pass.ts` |
| `GRAPH_RUN_MAX_CANCEL_ATTEMPTS`, `MAX_PASS_ROUNDS`, `MAX_VALUE_LOADS` | 3, 16, 32 | `graph-run-pass.ts` |
| Executor calls per pass: starting, observing, per provider, ceiling | 4, 8, 4, 16 | `graph-run-pass.ts` |
| `MAX_PLANNING_ROUNDS`, routed error message | 1,000, 1,300 chars | `graph-run-scheduling.ts` |
| `GRAPH_EDGE_TRANSFORM_MAX_ELEMENTS`, `GRAPH_EDGE_DELIVERY_MAX_ARTIFACTS` | 10,000, 256 | `graph-edge-transforms.ts` |
| `GRAPH_MERGE_MAX_ITEMS` | 10,000 | `graph-node-merge.ts` |
| `GRAPH_AGENT_SESSION_BOUNDS` repair prompt, continuation prompt, repair attempts, polls | 192 KiB, 16 KiB, 16, 64 | P`run-agent-session.ts` |
| `GRAPH_AGENT_PROGRESS_BOUNDS` items, item bytes | 50, 8 KiB | P`run-agent-session.ts` |
| `GRAPH_AGENT_QUESTION_BOUNDS` questions, question chars, choices, answer chars | 8, 4,000, 8, 8,000 | P`run-agent-session.ts` |
| `GRAPH_ASK_HUMAN_HOLD_MS`, held calls per process | 45 s, 256 | `graph-agent-questions.ts` |
| `GRAPH_READ_ARTIFACT_MAX_BYTES` | 64 KiB | `graph-agent-tools.ts` |
| `GRAPH_PROVENANCE_BOUNDS` sources, issues | 4,096, 32 | P`provenance.ts` |
| `GRAPH_RUN_TRANSCRIPT_CAPTURE_INTERVAL_MS` | 15 s | `graph-run-transcripts.ts` |
| Remote-ref guard: remotes, `ls-remote` attempts, listed refs, created commits, reflog entries | 8, 3, 100,000, 1,000, 200 | `graph-agent-guards.ts` |
| `GRAPH_WAIT_FOR_CHECKS_DEFAULT_MINUTES`/`MAX_MINUTES`; `GRAPH_CHECKS_NONE_GRACE_MS` | 60/360 min; 120 s | P`system-actions.ts`, `graph-system-checks.ts` |
| `run-validation` `outputBytes`; `GRAPH_SYSTEM_PARAM_BOUNDS` comment, message, subject | 1–32 KiB (8 KiB); 2,000, 2,000, 200 chars | P`system-actions.ts` |
| System job inline wait, safety observation | 2 s, 30 s | `graph-node-system.ts` |
| `GRAPH_HUMAN_BOUNDS` note, edit bytes/depth, pending interactions | 2,000 chars, 512 KiB/32, 64 | P`run-human.ts` |
| `GRAPH_CODE_REWIND_PREVIEW_COMMITS`, `_PATHS`, `GRAPH_REWIND_PREVIEW_NODES` | 50, 20, 64 | P`run-rewind.ts` |
| `GRAPH_RESTART_CANCEL_ATTEMPTS` | 3 | `graph-run-rewind.ts` |
| `GRAPH_ISOLATION_BOUNDS` branches, live worktrees per environment | 8, 16 | P`isolation.ts` |
| `GRAPH_RUN_ATTENTION_DEBOUNCE_MS` | 500 ms | `graph-run-attention.ts` |

**Surfaces:**

| Bound | Value | Where |
| --- | --- | --- |
| `GRAPH_LIBRARY_BOUNDS` project files, file bytes, project bytes, user templates, user bytes, trust records | 64, 1 MiB, 16 MiB, 200, 32 MiB, 128 | P`library.ts` |
| Project template watcher: settle, watched projects | 250 ms, 32 | B`graph-project-templates.ts` |
| `GRAPH_SHARING_BOUNDS` bundle, author, trusted keys, approved text per template/project, diff lines | 2 MiB, 120, 64, 256 KiB/4 MiB, 400 | P`sharing.ts` |
| `GRAPH_LAUNCH_BOUNDS` saved defaults, request id, input bytes, environment-less runs, retention | 64, 128, 256 KiB, 20, 7 days | P`launch.ts` |
| `GRAPH_MOCK_PIN_BOUNDS` nodes, pins per node, pin bytes, all pins, `maxStepMs` | 100, 20, 64 KiB, 256 KiB, 10 s | P`mock-pins.ts` |
| `GRAPH_MOCK_RUNS_RETAINED`, `GRAPH_MOCK_DEFAULT_PANEL`, `GRAPH_RUN_EFFECTS_LIMIT` | 20, 2, 500 | B`graph-mock-launch.ts`, `commands-registry-graph-mock.ts` |
| `GRAPH_DESCRIBE_BOUNDS` description, base draft, examples, issues | 8,000 chars, 64 KiB, 16 KiB, 32 | P`describe.ts` |
| `GRAPH_DESCRIBE_POLL_MS`, `MAX_PASS_FAILURES` | 3 s, 20 | B`graph-describe-service.ts` |
| `GRAPH_RUN_VIEW_BOUNDS` listed runs, inline artifact, transcript window default/max | 200, 512 KiB, 2/4 MiB | P`run-view.ts` |
| `PUBLIC_GRAPH_VALIDATE_TEXT_MAX_BYTES`, `PUBLIC_GRAPH_DIAGNOSTICS_MAX` | 512 KiB, 50 | `packages/protocol/src/public-api-inputs-graph.ts` |
| Coordinator status positions listed | 16 | B`coordinator-graph-actions.ts` |
| `GRAPH_DESIGNER_HISTORY_LIMIT`, `GRAPH_DESIGNER_COALESCE_MS` | 100, 1.5 s | W`components/graph-designer/graph-designer-history.ts` |
| `GRAPH_DRAFT_COMPILE_DELAY_MS`, `GRAPH_DESIGNER_MOCK_STEP_MS` | 250 ms, 1 s | W`components/graph-designer/GraphDesignerTab.tsx` |
| Import and bundle files | 2 MiB | W`GraphImportDialog.tsx`, `GraphShareDialogs.tsx` |
| Run store caches: artifacts, transcripts | 200, 32 | W`stores/graphRunStore.ts` |

## Invariants

The plan's invariants come on top of every invariant in the root `AGENTS.md`.

1. **The run record and its artifacts are the authority.** Every pass reads
   the stored run and saves with compare-and-swap; the designer, run view, CLI
   and coordinator rehydrate from revisioned snapshots (`graph_run_get` with
   `knownRevision`). Unmounting a view sends nothing; tests:
   `GraphRunTab.test.tsx` ("Rehydration"), `graph-run-view.spec.ts`.
2. **A compiled plan is frozen into the run at launch.** `GraphRun` stores the
   plan and its digest; executors read it, never the template. Sub-graph
   children are inlined into that plan and custom types travel in it, so
   editing or deleting either changes no run.
3. **Artifacts are immutable.** Ids hash content, producer and lineage;
   retries and rewinds add artifacts and supersede (`supersede` in
   `saveGraphRun`); nothing is deleted while the run exists.
4. **Results are validated when submitted.** The `graph-output` slot runs full
   type validation and provenance at submit; the artifact store validates
   again before storing; mock values go through the same store.
5. **Upstream content is untrusted.** Inputs reach prompts only through
   evidence frames; the locked system contract states the rule; taint reaching
   a side effect needs an acknowledgement.
6. **Everything is bounded.** See [Bounds](#bounds); appends past a run bound
   fail the run with `budget-exceeded` rather than evicting.
7. **Capabilities only narrow.** `compileGraphCapabilities` unions denials of
   profile, node, ceiling and environment and keeps the environment's sandbox
   and approvals; push and GitHub writes are denied on every agent node; MCP
   grants only select configured servers.
8. **Guards fail closed.** A baseline or remote listing that cannot be
   captured fails the activation before dispatch; a violation fails it and
   keeps the evidence in `guards`.
9. **Logs and metrics never carry payloads.** Graph modules log ids, codes,
   states, counts and bytes; receipts, notices and summaries (CLI, coordinator,
   attention keys) are content-free.

Root `AGENTS.md`'s background-work invariants apply too: a run is
backend-owned and keeps going while its environment is inactive or its tab is
closed; `graph-run` resource events are hints over revisioned snapshots; a
refused or malformed answer records nothing. The inactive path is checked on
a real stack for the run view (`graph-run-view.spec.ts`: launch, switch away,
finish, return, reload), and for human nodes (a wait answered while the
environment is away, and a wait surviving a backend restart).

## Known gaps

- **GitHub credential withholding** (item 209). Claude and Grok start a graph
  session's agent process without the GitHub credential, Codex withholds it
  from every command a graph thread runs (per-thread
  `shell_environment_policy`), and Pi from the session's shell tools and the
  MCP servers the bridge starts. The shared Codex app-server, Pi extensions
  (in the bridge process) and both OpenCode and Cursor (one process per
  environment) keep it. SSH keys, a container's runtime credential file and
  Git's `insteadOf` rewrite stay readable everywhere. The remote-ref guard
  detects pushes, not other GitHub writes, so the remote axis stays advisory.
- **Per-node MCP** (item 404). Grok cannot select MCP servers (advisory);
  Cursor read-only turns load only Orkestrator's server, and a selecting Cursor
  session loses user and project rules and plugins.
- **Isolated branches** are confined by guards, not by the provider: bridges
  keep one working directory per process. A per-session working directory in
  every bridge is a follow-up.
- **CLI waiting.** `graph launch` has no `--wait`; follow a run with
  `graph status`.
- **Token meter granularity.** `limits.maxTokens` reads the tokens an agent
  activation reports when it finishes, so the agents running when the meter
  is reached finish and can take the run past it (a soft limit by design).
- **Built-ins** keep their own engines; engine-only behaviours are not
  expressible as templates (item 108 Notes). Item 301 is not built here.
- **Live verification still needed.** No live-provider run has been recorded
  for: the design bake-off from launch to PR on two providers; backend restart
  mid fan-out on a real stack; read-only guards refusing a committing reviewer
  and the enforcement tiers matching on every provider (todo
  [0031](../todo/cross-cutting/0031-live-provider-and-platform-qualification.md),
  task 10); "Describe a graph" producing a compiling draft with a live model;
  the coordinator's graph wakes with a live coordinator; and the real-stack
  inactive-environment path for human nodes (start, switch away, answer later,
  return; the run view's launch, switch away, finish, return passes in
  `graph-run-view.spec.ts`). The Phase 2 exit criteria in
  [`000-index.md`](../../plans/graphs/000-index.md) track them.
