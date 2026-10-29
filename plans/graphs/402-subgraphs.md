---
id: 402
title: "Sub-graphs"
phase: 4
plan: "Phase 4"
status: done
depends_on: [107, 204]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1436"
updated: 2026-10-29
---

# 402 · Sub-graphs

- **Plan:** [Phase 4: extensions](../composable-graphs.md#phase-4-extensions)
- **Decisions:** D5
- **Depends on:** [107](107-compiler.md), [204](204-agent-node-executor.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A template can be used as one node of another template.

## Work

- [x] Write the design note in this file's Notes (written and built on 2026-10-29).
- [x] Get the design note agreed by the user. (Approved as built by the maintainer on 2026-10-29: [D22](../composable-graphs.md#decisions).)
  2026-10-29; per the user's standing Phase 4 instruction it is reviewed in the pull request.)
- [x] Compiler inlining with namespaced IDs and parameter pass-through.
- [x] The built-in Multi Review template usable as a block in user graphs.
- [x] Backend resolution over built-in, user and trusted project templates, with the compile cache
  keyed on each child's digest.
- [x] Runtime reads an inlined node's parameters from its sub-graph scope (prompts, `when`, gates,
  loop `until`).
- [x] Designer: the palette's Sub-graph menu, the sub-graph node form, browser compile of drafts
  with sub-graphs, diagnostics shown on the sub-graph node.

## Tests

- [x] The report §9.3 graph, including its Multi Review subgraph, compiles and runs.
- [x] One case per new diagnostic code; digest stability; designer sub-graph tests.

## Done when

- [x] Sub-graphs ship.

## Notes

**2026-10-29 · Design note.** The user's standing instruction for Phase 4 is to write the design
here and build it straight away; the note is reviewed in the pull request.

*Referencing a child.* A `subgraph` node names its child by `template: { scope, id, revision?,
digest?, path? }`: a built-in id, a user template id, or a project template in the compiling
project (`path` names its `.orkestrator/graphs/*.graph.json` file; without it the id must name
exactly one file). `digest` pins the child's `graphTemplateDigest` and `revision` its revision:
when set they must match what resolves (`subgraph-digest-mismatch`), so editing the child never
silently changes a parent that pinned it. The designer pins both when the user picks a child. An
unpinned reference compiles against whatever resolves and says so (`subgraph-unpinned`, info).
Either way invariant 2 holds: the run freezes the compiled plan, child included.

*Resolution is injected.* `compile(template, { resolveTemplate })` takes a synchronous
`GraphTemplateResolver: (ref) => { template } | { missing: reason } | undefined`, so the
compiler stays pure and browser-safe. The backend's `GraphTemplateService` passes one over
built-ins, user templates and the project's trusted templates; an untrusted or changed project
child resolves as `{ missing: "untrusted" }`. The designer passes one over built-ins (from code)
and a cache of user and project templates it fetches. With no resolver given, built-ins still
resolve from code (`graphBuiltinTemplateResolver`, they ship with the app) and user and project
children are `subgraph-unresolved` (`detail: "no-resolver"`).

*Inlining.* Before the passes run, `inlineGraphSubgraphs` (`compile-subgraphs.ts`) rewrites the
template into a flat one, and every later pass works on that, unchanged:
- Child nodes, edges and loops get namespaced ids `<subgraphNodeId>/<childId>` (nested:
  `outer/inner/node`). Plan node ids therefore follow `GRAPH_PLAN_NODE_ID_PATTERN` (graph ids
  joined by `/`, at most 128 characters), which activation keys, artifact producers, rewinds and
  loop-iteration keys accept. Item ids keep their derivation (`review/review/panel.2/issue-3`).
- The sub-graph node's input ports are the child's run inputs and its output ports the child's
  run outputs: same names and types; a node may omit an optional child input and any child
  output, and may not mark an optional child output required (`subgraph-port-mismatch`). A
  parent edge into `s.p` becomes one edge per child edge from run input `p` (transforms
  concatenated, parent's first); a parent edge out of `s.q` reads the child output's own source
  (`s/<node>[.outlet].<port>`). Run outputs, loop carries, `firstIterationFrom` and loop `until`
  roots that name the sub-graph are rewritten the same way.
- Parameters: each child parameter is bound by the node (`params`) to a literal (checked against
  the child's type, options and range) or to `{ param }` of the parent (same type; an enum's
  options must fit), or falls back to its default; one with neither is an error
  (`subgraph-param-binding`). Child prompts, `when`s, gates and `until`s keep reading
  `params.<childKey>`: the plan records each instance's resolved scope (`plan.subgraphs[].params`,
  every entry a literal or one of the plan's own parameters) and its parameter definitions, and
  the runtime reads a node's parameters through `graphPlanNodeParams`. Nested scopes compose.
- Roles: each child role maps through `roles` to a parent role, or to the parent role with the
  same key; multiplicities must match and a parent panel may not exceed the child's `maxPanel`
  (`subgraph-role-binding`). Inlined nodes, panel axes and lens roles name the parent role.
- Limits: the child's own limits and acknowledgements are not carried over. Cost is computed on
  the flat graph, so the parent's `maxAgentSessions` and `maxConcurrentAgents` cover the child's
  sessions summed with its own. Taint and floor warnings on inlined nodes are acknowledged in the
  parent (their digests name the namespaced ids).
- Nesting: depth at most `GRAPH_SUBGRAPH_MAX_DEPTH` (4; `subgraph-depth`); a template that
  reaches itself is `subgraph-recursive`; the flat graph is bounded (400 nodes, 1600 edges, 64
  loops; `subgraph-too-large`). A resolver is called once per reference per compile.
- Custom types: the child's types are merged; one `name@version` defined differently by parent
  and child is `subgraph-type-conflict`. A child that needs an environment inside a
  `workspace: none` parent is `subgraph-workspace`. The child's layout is ignored.
- Kept unsupported on the sub-graph node itself (`subgraph-unsupported`): `replicate`, `when`,
  `retry`, `timeoutMs`, `onFailure`, a child with loops inside a parent loop, and
  `session.from` naming a sub-graph. They would need per-branch inlining or region nesting.
- A sub-graph that cannot be inlined stays one opaque node in the flat template, so its ports are
  still type-checked; the compile has an error and no plan.

*Diagnostics on inlined nodes* carry the namespaced `nodeId`; their `path` is written in the
parent's terms, `nodes[<subgraph index>]>nodes[<child index>].…` (nested sub-graphs chain `>`),
so the designer highlights the sub-graph node.

*Trust and capabilities.* Inlined agent nodes keep their own profiles and are compiled against
the parent's ceiling and environment, so a child can only narrow (invariant 7); a project child
must be trusted at its current digest, like a launched project template (§6.9). Taint flows
through the inlined nodes, so the coarse "runs a sub-graph" side effect is gone from successful
plans.

*Multi Review as a block (D5).* A built-in child's `engine` is ignored when it is inlined: the
parent gets a copy of its nodes on the graph runtime, which is D5's "duplicate to customise"
done implicitly, and says so (`subgraph-engine-copy`, info). The built-in Multi Review gains two
optional outputs, `clean` (the reviewed branch when the report is clean) and `fixed` (the Fix's
commit), so a parent can open its own pull request on either; the engine is unaffected.

*Run view and restart.* The plan keeps `subgraphs: GraphPlanSubgraph[]` (absent when there are
none, so existing plan digests do not move) — each instance's id, parent instance, label,
resolved child `{scope, id, revision, digest, name, engine?}`, parameter scope and definitions,
role map, the plan node ids inlined from it, and its port map — and each inlined node and loop a
`subgraph` field naming its innermost instance. The run view groups by it; restart and rewind
work per activation and need nothing new.

*Out of scope.* Replicating a sub-graph, `when`/retry/timeout on a sub-graph node, nested loop
regions, editing a child in place from the parent, and a run view that collapses a sub-graph
into one card (211 may use `plan.subgraphs`).

**2026-10-29 · Built (files).** Protocol (browser-safe): `compile-subgraphs.ts` (pass 0,
`inlineGraphSubgraphs`), `subgraphs.ts` (new export `@orkestrator/protocol/graphs/subgraphs`:
`GraphTemplateResolver`, `GraphTemplateResolution`, `GraphSubgraphMissingReason`,
`graphBuiltinTemplateResolver`, `graphSubgraphRefKey`, `graphSubgraphPorts`, `graphPlanSubgraph`,
`graphPlanScopeParams`, `graphPlanNodeParams`, `graphPlanLoopParams`, `graphPlanNodeParameters`,
`GRAPH_SUBGRAPH_MAX_DEPTH` 4, `GRAPH_SUBGRAPH_MAX_RESOLUTIONS` 64); `grammar.ts`
(`GRAPH_PLAN_ID_PATTERN`, `GRAPH_PLAN_ID_MAX_CHARS` 128, `isGraphPlanId`, `GRAPH_PLAN_BOUNDS`
400 nodes / 1600 edges / 64 loops); `plan.ts` (`GraphPlanSubgraph`, `GraphPlanParamSource`,
optional `plan.subgraphs`, `node.subgraph`, `loop.subgraph`); `compile-state.ts`
(`resolveTemplate` option, `state.source`, `parametersOf`, `loopParametersOf`);
`compile-diagnostics.ts` (codes below, `mapPath`/`adopt`); `template-model.ts` +
`template-nodes.ts` (`GraphTemplateRef.digest`, `.path`, `GRAPH_PROJECT_TEMPLATE_PATH`);
`run-identity.ts`, `run-guards.ts`, `run-model.ts` (plan ids in activation keys, producers,
rewinds, loop-iteration keys; `maxLoops` 64); `predicate-shape.ts` (a leaf path's first segment
may be a plan id). Backend: `graph-template-service.ts` (`subgraphResolution`,
`resolveSubgraph`; `summary`/`compileResolved` are async now), `graph-agent-prompt.ts`,
`graph-node-gate.ts`, `graph-run-ready-set.ts`, `graph-run-loops.ts`
(`graphPlanScopeParams`). Web: `graph-designer-subgraphs.ts`, `GraphSubgraphEditor.tsx`,
`GraphPalette.tsx`, `GraphInspector.tsx`, `graph-designer-edits.ts` (palette item
`{ kind: "subgraph", ref, child }`), `graphDesignerStore.ts` (`subgraphTemplates`,
`loadSubgraphTemplate`), diagnostics mapping in `graph-designer-model.ts` and
`GraphCompilePanel.tsx`.

**2026-10-29 · Diagnostic codes.** Errors: `subgraph-unresolved` (`detail`: `not-found`,
`untrusted`, `ambiguous`, `no-project`, `no-resolver`, `invalid`), `subgraph-digest-mismatch`,
`subgraph-recursive`, `subgraph-depth`, `subgraph-too-large`, `subgraph-port-mismatch`,
`subgraph-param-binding`, `subgraph-role-binding`, `subgraph-type-conflict`,
`subgraph-workspace`, `subgraph-unsupported` (kept, now only for what inlining cannot keep).
Info: `subgraph-unpinned`, `subgraph-engine-copy`. 107's table lists them.

**2026-10-29 · Decisions and deviations.**
- *Built-in Multi Review outputs.* Its run outputs were `report` and `pr`; a parent that ships
  the reviewed branch itself needs the branch. Added two optional outputs, `clean`
  (`has-findings[clean].code`) and `fixed` (`fix-complete[complete].code`); exactly one arrives,
  on exclusive outlets, as for the built-in's own `describe-pr`. The engine is unaffected and its
  pinning tests pass.
- *§9.3 example.* `review` now inlines the built-in with `autoFix: { param: "autoFix" }` (a new
  parent parameter, default true) and `autoPr: false`; its outputs are `report`, `clean`,
  `fixed`; `describe-pr` and `pr` read `clean` or `fixed`; the run output `pr` is optional (with
  autoFix off, a review with findings ends without one); six taint acknowledgements replace the
  three of 107. The node is deliberately unpinned (a built-in moves with the app; the run freezes
  it), which compiles with `subgraph-unpinned` info.
- *Paths of rewired edges.* An edge rewired through a sub-graph input keeps the parent edge's
  path (the parent author made that connection); inlined entries otherwise point into the node
  (`nodes[4]>edges[2]`).
- *Constants are not folded.* A child node behind `when: params.autoPr` with `autoPr` bound to
  `false` still raises its taint warning (`review/pr` in §9.3): the compiler does not evaluate
  bound literals.
- *Test support.* The pass-through fake executors (`graph-run-executor-test-support.ts`) now seal
  reference-typed outputs (`review-package@2`) as files with `putFile`, which needs a run
  environment with a Git worktree; the §9.3 run test creates one.

**2026-10-29 · For later items.** 211: group inlined nodes by `node.subgraph` /
`plan.subgraphs[].nodes` (nested instances name `parent`). 213: mock and fake executors must
read an inlined node's parameters with `graphPlanScopeParams(plan, node.subgraph, params)`, and
node ids may contain `/`. 214: launch parameters are the parent's only (`plan.parameters`);
child parameters are bound in the plan. 301: the built-in Multi Review has the new optional
outputs `clean` and `fixed`. Not done: no real-stack browser pass of the Sub-graph menu and form
(component tests cover them; `graph-designer-editing.spec.ts` was not extended).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Design note written; inlining, resolution, runtime scope, designer and tests built; §9.3 with Multi Review inlined compiles and runs on the graph runtime. · complete; awaiting PR
- 2026-10-29 · coordinator · Split the design-note box: written, but agreement is still pending (the user's answer was never received; the build went ahead on the coordinator's recommended default). · Awaiting the user's review.
- 2026-10-29 · coordinator · The maintainer approved the design note as built (D22). · Awaiting PR.
- 2026-10-29 · coordinator · Delivered in https://github.com/orkestrator-ai/orkestrator-v2/pull/1436; status done. · None.
