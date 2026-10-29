---
id: 107
title: "Compiler"
phase: 1
plan: "P1.7"
status: done
depends_on: [101, 102, 104, 105, 106]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1436"
updated: 2026-10-29
---

# 107 · Compiler

- **Plan:** [P1.7 Compiler](../composable-graphs.md#p17-compiler)
- **Decisions:** D3, D4, D8, D9, D10, D11, D12
- **Depends on:** [101](101-template-schema.md), [102](102-type-library.md), [104](104-predicates.md), [105](105-prompt-templates.md), [106](106-capability-profiles.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A pure compiler that turns a template into a frozen, hashed plan, or explains exactly what is wrong with it.

## Work

- [x] `graphs/compile.ts`: `compile(template, {types, providers}) → {plan, diagnostics, cost}`. The plan is normalised and carries a digest. Diagnostics carry a node or edge ID, a code and a severity.
- [x] Checks: cycles outside loops; loops without a bound; type and cardinality; required inputs; producers on mutually exclusive gate branches; condition paths; workspace concurrency (D3); replicated writers; push or GitHub capabilities on agent nodes (D12); taint reaching side effects; unmet `minEnforcement`; prompt size; limits.
- [x] `graphs/cost.ts`: best-case and worst-case agent sessions and peak parallelism.
- [x] Port option `firstIterationFrom` for loops (report §9.2).
- [x] `graphs/lint.ts` collects prompt and template lints into the same diagnostics.
- [x] Reference checks the template guard leaves to the compiler (see [101](101-template-schema.md) Notes), and rejection of `subgraph` nodes until [402](402-subgraphs.md).
- [x] Output-port rules from [103](103-result-kind-registry.md): no `list<…>` outputs on agent nodes, no output names that collide with existing result tools.

## Tests

- [x] One test per diagnostic code.
- [x] ~~The report §9 examples compile.~~ (replaced by the next line: §9.3 and §9.4 use a sub-graph and `items` fan-out, which this item must reject until 402 and 401; see Notes)
- [x] The report §9.1 and §9.2 examples compile with no errors and may launch; §9.3 and §9.4 fail only with `subgraph-unsupported` and `replicate-items-unsupported`, and §9.3's taint warnings are acknowledged in the example. (2026-10-29: since item 401, §9.4 compiles with no errors and `replicate-items-unsupported` is gone; see Notes.)
- [x] The digest is stable across key order and layout changes.

## Done when

- [x] The compiler is merged with tests and every diagnostic code is documented in this file's notes.

## Notes

**2026-10-29 · Files.** All browser-safe under `packages/protocol/src/graphs/`, one package export
`./graphs/compile` (`compile.ts` re-exports the plan types, diagnostics and helpers):
`compile.ts` (entry, pass order), `compile-state.ts` (options, shared state, acknowledgements),
`compile-refs.ts` (guard translation, types, references, roles, node rules),
`compile-graph.ts` (topology, cycles, loops, `firstIterationFrom`, outlet conditions, time
order), `compile-ports.ts` (branches, edge types, transforms, zip, producers, collect, merges, run
outputs), `compile-conditions.ts`, `compile-agents.ts` (capabilities, floors, sessions),
`compile-workspace.ts`, `compile-taint.ts`, `cost.ts`, `lint.ts`, `compile-plan.ts` (assembly),
`plan.ts` (plan shape, digests), `compile-diagnostics.ts` (code table), `sha256.ts` (synchronous
pure-TS SHA-256; WebCrypto is async and `node:crypto` is not in the browser). Tests:
`compile-diagnostics.test.ts` (one case per code, typed `Record<code, Case>` plus a runtime
completeness test), `compile.test.ts` (examples, plan shape, digest, cost, robustness),
`sha256.test.ts`; fixtures in `compile-fixtures.test-support.ts`.

**2026-10-29 · API.** `compile(template: unknown, options?) → GraphCompileResult` (alias
`compileGraphTemplate`); never throws on bad input. Options (`GraphCompileOptions`):
`types?: ArtifactTypeDef[]` (a type library outside the template; the template's own types win,
a different definition under the same ref is `type-conflict`), `providers?: AgentPlatform[]`
(enabled platforms, default all), `ceiling?: GraphCapabilityCeiling` (D18, default no denials),
`environment?: NativeAgentExecutionPolicy` (default `GRAPH_COMPILE_DEFAULT_ENVIRONMENT`, a
workflow session that denies nothing), `host?: AgentEnforcementHost` (default
`GRAPH_COMPILE_DEFAULT_HOST` = no Claude sandbox, the conservative answer), `promptCeilingBytes?`
(default 160 KiB). Result: `{ok (no errors), launchable (ok and no pending acknowledgement), plan
(null on errors), diagnostics (errors, warnings, info; ≤ 500), omittedDiagnostics, cost (null only
when the guard fails), pendingAcknowledgements}`. Diagnostic: `{code, severity, message, nodeId?,
edgeId?, loopId?, path? (template path), detail? (delegated checker's code), port?, offset?,
length? (prompt), acknowledgement? {kind, digest, accepted}}`.

**2026-10-29 · Plan shape (`CompiledGraphPlan`, plain JSON).** `format:
"orkestrator.graph-plan"`, `formatVersion: 1`, `compilerVersion: 1`, `digest`, `templateDigest`,
`template {id, revision, name, description?, engine?}`, `parameters`, `roles` (as authored),
`types` (custom `ArtifactTypeDef`s the plan uses, by ref — runs keep them, report §5.12),
`typeRefs` (every ref used, sorted), `inputs [{name, type, label?, description?, required}]`,
`outputs [… + from]`, `workspace`, `order` (topological, ties by id), `nodes` (in `order`),
`edges` (by id), `loops` (by id), `limits`, `cost`, `acknowledgements {accepted, pending}` (each
`{kind, digest, code, nodeId}`), `context {ceiling, environment}`.
- Every node: `id, kind, label?, description?, order, loop?, inputs, outputs, when?,
  workspaceAccess, onFailure, retry {attempts, on}, timeoutMs?, fanOut {min, max}, skippable,
  taint {tainted, source?, sideEffect?, sources[]}`. Input port: `{name, type, label?,
  description?, required, render? (agent: effective mode), collect? (fan-in only, defaults
  filled), firstIterationFrom?, deliveredType, perBranch, fanIn, edges[], carries[]}`. Output
  port: `{name, type, label?, description?, required, provenance?, choices?, valueType (list<T>
  when replicated)}`. Value types are `{kind: named, ref} | {kind: shape, origin, schema,
  budgets} | {kind: list, element}`.
- Agent: `role, prompt, capabilities (CompiledGraphCapabilities + spec {profile, allow, deny}
  sorted), minEnforcement? (effective floor), floorLowered, session, replicate? {axes (lens role
  filled), branches, signature}, askHuman, grantedActions`. System: `action, params`. Gate:
  `branches, otherwise?, outlets`. Merge: `strategy`. Human: `form, outlets`. Subgraph (never in a
  plan until 402): `template, params, roles, replicate?`.
- Edge: `{id, from, to, transform[], zip, iterations: all|first|later, sourceType, deliveredType,
  budgetCheck, fanIn}`. Loop: `{id, label?, members (plan order), entry (members no member
  feeds), laterOnly (members that cannot run on iteration 1), until, maxIterations, carry [{from,
  to, type}]}`. Carry ids in ports are `<loopId>#<index>`.
- Cost (`GraphCompileCost`): `agentSessions {best, worst}`, `activations {best, worst}`,
  `peakParallelism`, `incomplete` (sub-graphs uncounted), `nodes [{nodeId, kind, branches,
  attempts, iterations, skippable, agentSessions, activations}]`.

**2026-10-29 · Defaults filled.** `required` true; agent `render` = 105's effective mode;
`collect` on fan-in ports `{wait: all-settled, minSuccessful: 1, includeFailures: true}`
(`GRAPH_DEFAULT_COLLECT_POLICY`, report §4.4), `first` gets `count: 1`; `session {mode: fresh}`;
`retry {attempts: 1, on: []}`; `onFailure` `fail-run`, except `skip` for replicated nodes (the
receiving collect policy decides, as today's reviewers); `askHuman` false; `transform []`, `zip`
false; system `params {}`. Workspace access of system actions (`GRAPH_SYSTEM_ACTION_WORKSPACE`):
`prepare-environment` write; `run-validation`, `run-validation-and-seal`, `push-branch`,
`open-pull-request` read; the rest none. A sub-graph counts as a writer until 402 inlines it.

**2026-10-29 · Digests.** `digest` = SHA-256 hex over `canonicalJson` of the plan without
`digest`; nodes are in topological order with id ties, edges and loops by id, so key order, node
and edge order and `layout` (not in the plan) do not change it. It covers `context` (ceiling and
environment change compiled policies) but not `providers` or `host`, which only decide
diagnostics. `verifyGraphPlanDigest(plan)` re-checks a stored plan (201).
`graphTemplateDigest(template)` hashes the template without `layout`, nodes/edges/loops by id and
types by ref; it is independent of options, so it suits trust records (109).
Warning digests (`graphWarningDigest`) hash `{kind, code, …facts}`: taint `{node, effect,
sources [{node, reason}]}`, floor `{node, profile, minEnforcement, defaultFloor}`. An
acknowledgement `{kind, digest}` in the template turns the warning into `info` with
`acknowledgement.accepted: true`; unmatched acknowledgements are `acknowledgement-stale`.

**2026-10-29 · Semantics decided here.**
- Edges must form a DAG; iterations feed back only through `carry`. Loops may not overlap or
  nest, and a region must be contiguous. `firstIterationFrom`: the matching edge (from outside
  the loop) delivers on iteration 1, the port's other producers (inside edges, carries) later.
- Mutual exclusivity: each node gets the gate and human outlets it needs taken (union over
  required inputs of what all of that input's producers share). Two producers are exclusive when
  they need different outlets of one node. Several producers into a single-value port must be
  pairwise exclusive (per `firstIterationFrom` group); list ports accept several producers.
- Time order for D3: two nodes run concurrently unless a path orders them, a loop's later-only
  member waits for iteration 1, a consumer of a loop member waits for the last iteration, or they
  sit on exclusive outlets. Readers concurrent with a writer, or two writers, are errors.
- Best case skips every node with a `when`, behind an outlet, or fed only by skippable producers
  — unless the producers cover every outlet of a gate with `otherwise` (or a human node), as
  Verify's commit does in §9.2 — and later-only loop members. Peak parallelism is a maximum-weight
  antichain over that time order (flow form of Dilworth), weights = worst-case branches; an
  upper bound because exclusive branches are counted together.
- **Taint (deviation, recorded).** The report counts any node "with network". Sources here are
  agent nodes whose profile or own overrides grant web access (`researcher`, `allow:
  ["web.search"]` or `["network"]`) and keep it after the ceiling and environment, plus
  `wait-for-checks` (CI output). A builder's environment-level network (package installs) is not a
  source: otherwise §9.1 and §9.2 (builder → builder) would warn and every graph would need an
  acknowledgement. No built-in type is an "external input type" yet; run inputs (tickets) are the
  user's. Sinks: agent nodes keeping shell and network (builder, verifier, custom), `push-branch`,
  `open-pull-request`, `run-validation(-and-seal)` (they run commands from a plan) and sub-graphs.
  Taint passes human nodes; the message names them as the mitigation. One warning per sink.
- `minEnforcement` is unmet when no enabled provider's tier (`agentPlatformsMeetingFloor` over
  the compiled policy) meets the effective floor (D4 default for read-only profiles).

**2026-10-29 · Fixture changes (101 allowed them).** §9.2 `verify` loses `minEnforcement:
"provider-configured"`: 106's matrix rates the verifier advisory on every provider (its shell may
write; the post-hoc guard holds the sources), so the floor was unmeetable. §9.3 gains three taint
acknowledgements (build, the review sub-graph, pr). When 402 inlines the sub-graph, its digests
change and the example needs new ones.

**2026-10-29 · For 103 (coordinator note).** Agent output ports may not be `list<…>` (replication
lifts them) and may not be named `workflow_result` or a result kind's tool suffix
(`GRAPH_RESERVED_OUTPUT_PORT_NAMES`, derived from `WORKFLOW_RESULT_KINDS` with `-` → `_`;
`isGraphReservedOutputPortName`). Result keys are minted by the runtime (204), not the template;
port names already satisfy `^[a-z][A-Za-z0-9_]*$` ≤ 48, inside `^[A-Za-z0-9_-]{1,128}$`.

**2026-10-29 · Item 402 (sub-graphs).** `subgraph-unsupported` no longer rejects every
sub-graph: 402 inlines them before the passes (`compile-subgraphs.ts`) and adds the
`subgraph-*` codes in the table below, each with a case in `compile-diagnostics.test.ts`.
§9.3 now compiles cleanly and may launch with the built-in Multi Review inlined; its taint
acknowledgements were replaced (six sinks: build, review/plan, review/package, review/fix,
review/pr, pr). The two "§9.3 fails only with `subgraph-unsupported`" statements above are
historical. See [402](402-subgraphs.md).

**2026-10-29 · Findings for others.** Built-in budgets exceed the 160 KiB prompt ceiling
(`ticket@1` 256 KiB, `review-report@1` 384 KiB), so any user template that inlines one gets
`prompt-size-over-ceiling` (§9.3's designers and judge do); 102/105 may want to reconcile budgets
and the ceiling. §9.3 and §9.4 cannot compile cleanly until 402 and 401 (their own tests say so).

**2026-10-29 · Diagnostic codes.** Compiler codes (`GRAPH_COMPILE_DIAGNOSTIC_CODES`; severity
from `GRAPH_COMPILE_DIAGNOSTICS`). `detail` carries the delegated code where one exists.

| Code | Severity | When |
| --- | --- | --- |
| `template-invalid` | error | The 101 guard fails; `detail` = guard code, `path` from the guard. |
| `type-invalid` | error | A custom type (template `types[…]` or library `$types[…]`) fails 102's checks, e.g. an unknown schema keyword (`detail: unsupported_keyword`). |
| `type-conflict` | error | Template and library define one `name@version` differently. |
| `type-unresolved` | error | A port or run input/output type does not resolve (`type_ref`, `unknown_type`, `unknown_version`). |
| `unknown-node` | error | An edge, carry, run output or loop names a missing node. |
| `unknown-port` | error | A port missing in that direction (outlets forward inputs). |
| `unknown-input` | error | An edge reads a missing run input. |
| `unknown-outlet` | error | An outlet the gate or human node does not have. |
| `outlet-required` | error | An edge from a gate or human node without an outlet. |
| `outlet-not-applicable` | error | An outlet on another kind of node. |
| `unknown-role` | error | A node, panel axis, lens or sub-graph binding names a missing role. |
| `role-multiplicity` | error | Panel replication on a one-model role, or a panel role without panel replication. |
| `subgraph-unresolved` | error | 402: the child does not resolve (`detail`: `not-found`, `untrusted`, `ambiguous`, `no-project`, `no-resolver`, `invalid`). |
| `subgraph-digest-mismatch` | error | 402: a pinned `digest` or `revision` the child no longer has. |
| `subgraph-recursive` | error | 402: a child contains itself, directly or through others. |
| `subgraph-depth` | error | 402: nesting deeper than `GRAPH_SUBGRAPH_MAX_DEPTH` (4). |
| `subgraph-too-large` | error | 402: the flat plan exceeds `GRAPH_PLAN_BOUNDS`, an inlined id exceeds 128 characters, or more than 64 children resolve. |
| `subgraph-port-mismatch` | error | 402: node ports that are not the child's run inputs/outputs (name, type, requiredness), render/collect/provenance/choices on them, or an edge to an undeclared port. |
| `subgraph-param-binding` | error | 402: an unknown child parameter, a literal that does not fit, a pass-through of another type, enum options or range, or a child parameter with no default left unbound. |
| `subgraph-role-binding` | error | 402: an unknown or unbound child role, another multiplicity, or a parent panel wider than the child's. |
| `subgraph-type-conflict` | error | 402: the child defines a custom type differently. |
| `subgraph-workspace` | error | 402: a child that needs an environment in a `workspace: none` parent. |
| `subgraph-unsupported` | error | Since 402 only what inlining cannot keep: `replicate`, `when`, `retry`, `timeoutMs`, `onFailure` on the sub-graph node, a child with loops inside a parent loop, a session continued from a sub-graph, a carry through a transforming child edge. |
| `subgraph-unpinned` | info | 402: the child is not pinned by digest. |
| `subgraph-engine-copy` | info | 402: a built-in child runs as a copy on the graph runtime, not on its engine. |
| `replicate-items-input` | error | An `items` axis (also inside `cross`) names an input that is neither `list<T>` nor of a type that declares `items` (401; replaced `replicate-items-unsupported`). |
| `output-port-list` | error | An agent output port typed `list<…>` (103). |
| `output-port-reserved` | error | An agent output named `workflow_result` or a result kind's tool suffix (103). |
| `error-port-type` | error | An output named `error` that is not `error@1`. |
| `route-without-error-port` | error | `onFailure: route` without an `error@1` output. |
| `graph-cycle` | error | Edges form a cycle (inside or outside a loop). |
| `loop-unbounded` | error | A loop without a whole-number `maxIterations`. |
| `loop-bound-exceeded` | error | `maxIterations` above 10. |
| `loop-overlap` | error | A node in two loops. |
| `loop-not-contiguous` | error | A path leaves a region and re-enters it. |
| `loop-carry-outside` | error | A carry endpoint is not a member of its loop. |
| `first-iteration-invalid` | error | `detail`: `not_in_loop`, `no_edge`, `inside_loop`, `no_later_source`. |
| `edge-type-mismatch` | error | Assignability fails (`version_mismatch`, `nominal_target`, `storage_mismatch`, `schema_mismatch`); adapters suggested. Also carries. |
| `edge-cardinality` | error | One value into a list port or a list into a single-value port. |
| `edge-transform-invalid` | error | A transform does not apply (`requires_list`, `unknown_field`, …); path names the transform index. |
| `edge-zip-invalid` | error | `zip` without replicated nodes at both ends, with different replication, or into an items input. |
| `input-unbound` | error | A required input with no edge or carry. |
| `input-multiple-producers` | error | Several producers into a single-value port that are not on exclusive outlets. |
| `collect-unsatisfiable` | error | `minSuccessful`/`count` above the producers' most branches. |
| `collect-without-fan-in` | warning | A collect policy no replicated producer feeds. |
| `merge-invalid` | error | Merge input/output count, list input, output type, items for concat/dedupe, dedupe keys, vote path, best score (`detail`). |
| `output-type-mismatch` | error | A run output's source does not fit its declared type. |
| `condition-invalid` | error | `when`, gate branch, `until` or edge `filter` fails 104's checker (`detail`: `unknown_root`, `unknown_path`, `operator_type`, …). |
| `workspace-unavailable` | error | A node reads or writes the workspace in a `workspace: none` template. |
| `workspace-concurrent-writers` | error | Two writers can run at once (D3). |
| `workspace-read-write-race` | error | A reader can run while a writer writes (§6.7). |
| `replicated-writer` | error | A replicated node that writes (D3). |
| `enforcement-unmet` | error | No enabled provider meets the node's effective floor (`detail` = floor). |
| `enforcement-floor-lowered` | warning, acknowledgement | A floor below the profile default (D4); kind `enforcement-floor`. |
| `taint-reaches-side-effect` | warning, acknowledgement | Untrusted content reaches a side effect (§5.13); kind `taint`. |
| `acknowledgement-stale` | info | An acknowledgement matches no current warning. |
| `session-source-invalid` | error | `session.from` is missing, not an agent node, or itself. |
| `session-role-mismatch` | error | Different role, or a panel role (§5.2). |
| `session-not-predecessor` | error | `from` does not feed the node by an edge or carry. |
| `session-replicated` | error | Either end replicated. |
| `limit-agent-sessions` | error | Worst-case sessions over `limits.maxAgentSessions`. |
| `limit-activations` | error | Worst-case activations over the hard cap of 200. |
| `fanout-too-wide` | error | A node's branch product over 32. |
| `concurrency-capped` | info | Peak parallelism above `limits.maxConcurrentAgents`. |
| `output-unused` | warning | An output of a non-terminal node nothing consumes (not `error`). |
| `run-input-unused` | warning | A run input nothing reads. |
| `outlet-unused` | info | A gate or human outlet with no consumer. |
| `iteration-outside-loop` | warning | `run.iteration` in a condition of a node in no loop. |
| `workspace-unpinned` | warning | A read/write agent with no `workspace` or `review-package` input (§6.7 rule 3). |

Passed through unchanged: 106's `capability-remote-write` (D12), `capability-mcp-grant`,
`capability-allow-unused` (warning), `capability-workspace-write-denied`,
`capability-workspace-read-writable` (tested here too), and every `prompt-*` code of 105
(`GRAPH_PROMPT_DIAGNOSTIC_CODES`, tested in 105; `prompt-size-over-ceiling` and
`prompt-unbound-variable` are also tested through `compile`).

**2026-10-29 · Changed by 108.** `output-unused` no longer reports a port that a loop's `until`
reads (`<node>.<port>`). Test in `compile.test.ts`. See [108](108-builtin-templates.md) Notes.

**2026-10-29 · Phase 1 exit criterion.** The per-code table in `compile-diagnostics.test.ts`
(typed over `GraphCompileDiagnosticCode | GraphCapabilityIssueCode`, so 106's
`GRAPH_CAPABILITY_ISSUE_CODES` are covered too) is the compiler's evidence. The other Phase 1
modules now have the same kind of table: `predicate-typecheck.test.ts`, `predicate-eval.test.ts`,
`prompt-diagnostics.test.ts`, `schema-subset.test.ts`.

**2026-10-29 · Item 401.** `replicate-items-unsupported` was removed when item 401 shipped `items`
fan-out. Its replacement, `replicate-items-input`, checks the replicated input's type; its case in
`compile-diagnostics.test.ts` changes §9.4's input to a single `validation-failure@1`. §9.4 now
compiles with no errors (`compile.test.ts`).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Compiler passes, plan with digests, cost, lints, taint and acknowledgements, 103's port rules, per-code tests, example acknowledgements; 102 box ticked, 104/105 boxes split. · complete; awaiting PR
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Recorded the per-code coverage evidence for the Phase 1 exit criterion. · complete; awaiting PR
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Item 401: `replicate-items-unsupported` replaced by `replicate-items-input` in the table and the per-code tests. · complete; awaiting PR
- 2026-10-29 · coordinator · Delivered in https://github.com/orkestrator-ai/orkestrator-v2/pull/1436; status done. · None.
