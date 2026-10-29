---
id: 101
title: "Template schema"
phase: 1
plan: "P1.1"
status: in-progress
depends_on: []
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-phase1-protocol"
pr: ""
updated: 2026-10-29
---

# 101 · Template schema

- **Plan:** [P1.1 Template schema](../composable-graphs.md#p11-template-schema)
- **Decisions:** D2, D8, D9, D10
- **Depends on:** none
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A versioned, bounded JSON shape for graph templates, with guards, that every later item builds on.

## Work

- [x] `packages/protocol/src/graphs/template.ts`: `GraphTemplateV1` with parameters, roles, types, inputs, workspace, nodes (`agent`, `system`, `gate`, `merge`, `human`, `subgraph`), edges, loops, limits and layout (report §4.5).
- [x] Hand-written guards in the protocol's style; an ID and label grammar; byte and count bounds on every string and list.
- [x] `subgraph` is accepted by the schema; the compiler rejects it until [402](402-subgraphs.md). (Schema half done here; the compiler half is a box on [107](107-compiler.md), see Notes.)
- [x] Role `defaultsFrom` names `ActionDefaultKey` values. Panel positions beyond the second come from `MultiReviewAgentSettings.additionalReviewers`.
- [x] Export the module from the protocol package.

## Tests

- [x] The guard accepts the example templates in report §9.
- [x] The guard rejects each malformed shape and every bound overrun.

## Done when

- [x] Schema and guards are merged with tests, and the shape is described in this file's notes until [216](216-documentation.md) writes the living doc.

## Notes

**2026-10-29 · Files and exports.** All under `packages/protocol/src/graphs/`, browser-safe
(a new `.oxlintrc.json` block forbids `node:`/`bun:`/`../testing/*` and value imports of
`../node/*` there; pinned in `tests/unit/domain-import-boundaries.test.ts`). Package exports:
`./graphs/template` (the model re-exported from `template-model.ts`, plus the guard; node checks
live in `template-nodes.ts`), `./graphs/grammar`, `./graphs/predicates`,
`./graphs/artifact-type-def`, `./graphs/examples`.

**2026-10-29 · Guard API.** `validateGraphTemplate(value): FieldValidation<GraphTemplateV1>`
(the `field-validation.ts` result: `{ok, value}` or `{ok: false, errors: [{path, code, message}],
omittedErrors}`, at most `GRAPH_TEMPLATE_MAX_ERRORS` = 50 errors), `isGraphTemplateV1`,
`parseGraphTemplate(text)` (byte check first, then `parseStrictJson`, which refuses duplicate
keys). Paths look like `nodes[3].replicate.lenses[0].label`; the root is `$`. Order: depth
(48) and size (1 MiB serialized) before anything is walked, then `format`
(`"orkestrator.graph"`), then `formatVersion` (`1`, else `unsupported_version`), then fields.
Error codes: `required`, `type`, `unknown_field`, `empty`, `too_long` (characters), `too_large`
(UTF-8 bytes), `too_many`, `too_few`, `too_deep`, `pattern`, `enum`, `out_of_range`,
`not_integer`, `not_finite`, `not_json`, `control_character`, `whitespace`, `duplicate`,
`conflict`, `capability`, `type_ref`, `timestamp`, `format`, `unsupported_version`,
`collect_requires_list`, `not_applicable`, `unknown_port`, `panel_only`, `must_be_last`,
`nested_cross`, `predicate`, `invalid_json`.

**2026-10-29 · What the guard checks and what it leaves to 107.** The guard checks shape,
grammar, bounds, uniqueness within each scope (node, edge, loop ids; role, parameter, run
input/output names; ports per node and direction; outlets; lens keys; type `name@version`;
acknowledgement `kind:digest`) and rules local to one object (collect `count` vs `wait`,
`maxPanel` only on panel roles, `additionalReviewers` placement, parameter defaults within
min/max/options, `replicate.items.input` and human `form.edit` naming one of the node's own
inputs, allow/deny disjoint). It deliberately does **not** check references or graph rules, so
the compiler can pin them to a node or edge: edge and carry endpoints exist (node, port, outlet,
run input), `firstIterationFrom` matches an edge into that port, role keys (node `role`, panel
`replicate.role`, lens `role`, subgraph `roles` values) exist, `session.from` and loop members
exist, type refs resolve (built-in or `types`) and custom type names do not shadow built-ins,
the panel product of `cross` fits 32, an `error` output port is `error@1`, and `subgraph` is
rejected until 402. Recommendation for 107: also reject `replicate: items` until 401, since the
Phase 2 runtime supports panel, lenses and samples only.

**2026-10-29 · Shape.** `GraphTemplateV1 = {format, formatVersion: 1, id, revision, name,
description?, engine?, parameters, roles, types?, inputs, outputs?, workspace, nodes, edges,
loops?, limits, layout?, acknowledgements?}`.
- Grammar: ids (template, node, edge, loop, role key, lens key, type name, built-in prompt id,
  adapter, subgraph template id) are kebab-case `GRAPH_ID_PATTERN`, ≤ 64. Keys (ports,
  parameters, run inputs and outputs, outlets, system param keys) are identifiers
  `GRAPH_KEY_PATTERN` (`^[a-z][A-Za-z0-9_]*$`, ≤ 48), so `submit_<port>` is a valid tool name
  and `params.autoFix` a valid path. Field paths are dotted `GRAPH_PATH_SEGMENT_PATTERN`
  segments (hyphens allowed, so `has-findings.x` works), ≤ 256 chars and 16 segments. Type refs
  are `name@major` or `list<…>` up to two deep (`parseGraphTypeRef`). Labels are single-line
  text without control or bidi-override characters, ≤ 200 bytes; lens labels ≤ 64 characters
  (P0.5). Every bound is in the frozen `GRAPH_TEMPLATE_BOUNDS`.
- `parameters`: `{key, label?, description?, type, default?}` with `boolean`, `integer` and
  `number` (`min?`, `max?`), `string` (`maxBytes?` ≤ 4 KiB) and `enum` (`options`). No
  default means the launcher must ask.
- `roles`: `{key, label?, description?, multiplicity: one|panel, maxPanel? ≤ 32,
  defaultsFrom?}`. `defaultsFrom` takes the plan's seven keys
  (`GRAPH_ROLE_DEFAULT_ACTION_KEYS`: review, review2, reviewPreparation, fixReviewIssues,
  verify, pr, resolve — not newProject, createScript or push) plus `additionalReviewers`, which
  is panel-only and last: one panel position per action key, then the
  `MultiReviewAgentSettings.additionalReviewers` list (report §9.1 writes exactly this).
- `types`: structural `ArtifactTypeDef = {name, version, label?, description?, schema (bounded
  JSON object, 64 KiB, depth 32), storage: value|reference, budgets {maxBytes ≤ 384 KiB value /
  32 MiB reference, maxStringBytes? ≤ maxBytes, maxItems? ≤ 10 000}, items? {path, idPrefix},
  sharedFields?, render? {markdown?, summary?}, example?}`. No `validator`: domain validators
  are for built-in types only. 102 refines it (schema subset, example against schema).
- `inputs` (run inputs) `{name, type, label?, description?, required?}`; `outputs`
  `{name, type, …, required?, from: {node, port, outlet?}}` (run results, and what a subgraph
  node exposes).
- `workspace`: `{kind: "environment", create?: {kind: worktree|container}}` or `{kind: "none"}`.
- Ports: inputs `{name, type, label?, description?, required?, render?, collect?,
  firstIterationFrom?}`; outputs `{name, type, label?, description?, required?, provenance?}`.
  `collect` only on list types: `{wait: all-settled|quorum|first, count? (required for quorum,
  absent for all-settled), minSuccessful ≤ count, includeFailures}`.
- Node common: `id, label?, description?, inputs?, when?`. Per kind (other fields are
  `unknown_field`): **agent** `outputs?, retry?, timeoutMs?, onFailure?, role, prompt
  ({builtIn} | {template ≤ 32 KiB}), capabilities ({profile, allow?, deny?}),
  workspaceAccess, minEnforcement?, session? ({mode: fresh} | {mode: continue, from}),
  replicate?, askHuman?`; **system** `outputs?, retry?, timeoutMs?, onFailure?, action,
  params?` (bounded scalar or scalar-list record); **gate** `branches [{to, when, label?}],
  otherwise?` (no outputs, retry or timeout); **merge** `outputs?, strategy, onFailure?` with
  `concat | dedupe {key[]} | vote {tie: fail|first, path?} | best {score, prefer?} | collect`;
  **human** `form, timeoutMs?, onFailure?` with `approve | edit {edit: inputPort} | choose
  {options [{to, label, description?}] 2–16}`, plus `instructions?`; **subgraph** `outputs?,
  retry?, timeoutMs?, onFailure?, template {scope, id, revision?}, params? (literal or
  {param}), roles? (inner → outer), replicate?`.
- Replicate: `{over: panel, role} | {over: lenses, lenses [{key, label, instruction, role?}]} |
  {over: items, input, maxBranches} | {over: samples, count} | {over: cross, axes: 2–3
  distinct axes}`; every count ≤ 32.
- Capabilities: profiles `observer, reviewer, verifier, researcher, builder, custom` (no
  `shipper`, D12). Names are `GRAPH_CAPABILITIES` (native six plus `git.commit`, `git.push`,
  `github.write`, `subagents`), `mcp:<server>` and `orkestrator:<group>`
  (`GRAPH_ORKESTRATOR_CAPABILITY_GROUPS`). The schema accepts `git.push`/`github.write` so 107
  can reject them on agent nodes with a pinned diagnostic. 106 owns what profiles mean.
- Edges: `{id, from: {node, port, outlet?} | {input}, to: {node, port}, transform?, zip?}`.
  Transforms: `pick {fields}`, `filter {where: predicate}`, `limit {count ≤ 1000}`, `flatten
  {path}`, `adapt {adapter}`, ≤ 8 per edge.
- Loops: `{id, label?, nodes, until, maxIterations 1–10 (required), carry [{from: {node, port,
  outlet?}, to: {node, port}}] ≤ 16}`.
- `limits`: `{maxAgentSessions ≤ 200, maxConcurrentAgents 1–32, maxTokens?, maxWallClockMs?}`.
  `layout`: node id → `{x, y}`. `acknowledgements`: `{kind: taint|enforcement-floor, digest
  (64 lower-case hex, as 107 prints it), acknowledgedAt (RFC 3339 UTC), code?, note?}`; this
  is where P2.12 stores taint acknowledgements, and where D4's lowered enforcement floor is
  acknowledged.

**2026-10-29 · Decisions taken here.**
- Gates and human nodes declare no outputs. Each *outlet* (a branch `to`, `otherwise`,
  `approved`/`rejected`, or a choice `to`) forwards every input of the node, addressed as
  `{node, outlet, port}`. This lets one gate forward several artifacts (the §9.2 gate forwards
  both the report and the commit, so Verify's `code` has producers only on exclusive outlets).
  `graphNodeOutlets(node)` lists them. The `edit` form's `approved` outlet carries the edited
  value of the named input.
- `capabilities` is always an object; the report's `capabilities: builder` is
  `{profile: "builder"}`, so there is one canonical form for digests and forms.
- Node and role labels are optional (the §9 sketches omit them); the UI falls back to the id.
- `run-validation` joins the P2.7 system actions because report §9.4 uses it; 207 must
  implement it or 107 must flag it. System action params are a generic bounded record; 207 owns
  per-action rules.
- `engine` (for 108), top-level `outputs` (for subgraphs and run results) and `acknowledgements`
  are additions to the §4.5 sketch.
- Predicates: the AST and a structural guard live in `graphs/predicates.ts`
  (`GraphPredicate`, `checkGraphPredicate`, `validateGraphPredicate`, `isGraphPredicate`; depth
  ≤ 8, ≤ 64 nodes, `in` ≤ 64 values, strings ≤ 1 KiB, ordering against numbers only, `count`
  as `{path, op: "count", compare, value}`). 104 extends that module with path roots, the type
  checker and the evaluator rather than redefining the shape. Path roots by position: `when` and
  gate branches start at an input port, `params` or `run`; loop `until` starts at
  `<nodeId>.<port>`; `filter` is relative to one list element.

**2026-10-29 · Examples.** `graphs/examples.ts`: `GRAPH_TEMPLATE_EXAMPLE_KEYS`
(`multi-review` §9.1, `build-pipeline-loop` §9.2, `design-bake-off` §9.3, `failure-diagnosis`
§9.4), `graphTemplateExample(key)` and `graphTemplateExamples()` (fresh copies, with
`reportSection` and `title`). Filled-in omissions: names, limits, built-in prompt ids, every
edge; a `describe-pr` agent producing `pr-description@1` in §9.1 and §9.3 (the report notes it
needs a producer); the §9.3 judge also outputs the chosen brief (`provenance: cite`) for the
human `edit` node; §9.2 completes the nodes around the loop after Phase 0. The §9.3 taint
acknowledgement is not encoded because it needs 107's warning digest. 107 may adjust the
fixtures if a compile rule needs it.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Template model, guards, bounds, predicate shape, §9 example fixtures, exports, lint boundary and tests; compiler box added to 107. · complete; awaiting PR
