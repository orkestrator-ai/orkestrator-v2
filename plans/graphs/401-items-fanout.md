---
id: 401
title: "`items` fan-out"
phase: 4
plan: "Phase 4"
status: done
depends_on: [205]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1436"
updated: 2026-10-29
---

# 401 · `items` fan-out

- **Plan:** [Phase 4: extensions](../composable-graphs.md#phase-4-extensions)
- **Decisions:** D9, D10
- **Depends on:** [205](205-replication-and-collection.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

One branch per item of a list artifact, for example per story, per failing test or per finding.

## Work

- [x] Write the design note in this file's Notes (written and built on 2026-10-29).
- [x] Get the design note agreed by the user. (Approved as built by the maintainer on 2026-10-29: [D22](../composable-graphs.md#decisions).)
- [x] `replicate: { over: "items" }` with `maxBranches`; `{{item}}` and `{{item.index}}` in prompts.
- [x] Per-item provenance carried through to downstream nodes.

## Tests

- [x] The report §9.4 loop runs with `items` fan-out.
- [x] `maxBranches` truncation is explicit, not silent.

## Done when

- [x] `items` fan-out ships.

## Notes

### 2026-10-29 · Design note

Per the user's standing Phase 4 instruction this note was written first and
the work built straight after it; the user reviews the note in the pull
request.

**Shape.** `replicate: { over: "items", input: <port>, maxBranches, truncate? }`
with `truncate: "first" | "fail"` (default `"first"`). It combines with panel,
lenses and samples through `{ over: "cross", axes: [...] }` like the other
sources.

**The input.** The named input port must be `list<T>` (each element is one
item: one element artifact) or a named type that declares `items` (each entry
of its item list is one item; the artifact itself is the branch's input).
Anything else, including `list<list<T>>`, is the compile error
`replicate-items-input`. Per branch the port and `{{item}}` hold the element:
`T` for a list, the item schema for a type with `items`. The port cannot be
zipped (existing `edge-zip-invalid` rule).

**Expansion at run time (D10: data becomes control flow, never agents).** The
node position resolves its items input once, unbranched and through its edge
transforms, as soon as every input is resolvable. Its `when` is evaluated once
for the whole position, on the whole list (`failures nonEmpty`). The runtime
then records a fan-out on the run record (`run.fanOuts`, `GraphItemFanOut`):
the items that run (branch key, 1-based index in the input, stable id, the
artifact holding it), the input's `total`, and the ids it did not run. The
branch set is those items times the node's other axes, and the branch
activations are created in the same planning round as the record. The record
is the authority: it is never recomputed, so a retried, restarted or recovered
branch reads the same item.

- An absent required items input or a false `when` skips the position: one
  unbranched `skipped` activation, so consumers skip as they do for any
  skipped producer. An empty list records a fan-out with `total: 0` and the
  same unbranched skip: "nothing to do" propagates as absence, exactly as a
  fan-in whose branches were all skipped.
- A failed delivery of the items input (a budget, a transform) fails the
  position: one unbranched `failed` activation; `onFailure` applies.

**Truncation is explicit, never silent.** `maxBranches` is the bound the
compiler priced. With `truncate: "first"` (default) the first `maxBranches`
items in input order run; the fan-out records `total` and the truncated ids
(at most 32 by name), and the run view shows "N of M items run" on the node.
With `truncate: "fail"` the position fails with `budget-exceeded` naming both
counts before any branch starts. Why `first` by default: the cap is a cost
bound on data the author does not control, and a bounded loop stays useful
(report §9.4: the next iteration revalidates and diagnoses what is left),
while the record and the view make the cut visible. A truncation marker
artifact delivered downstream was rejected: every consumer would need a port
of a new type for it; the fan-out record is the node's own report.

**Branch keys** are `item.<k>`, where `<k>` is the item's stable id (205's
`run-items.ts` derivation) encoded into the branch key grammar: `/` becomes
`:`, `$` is dropped, any other character outside the grammar becomes `-`
(`validate/failure-3` → `item.validate:failure-3`). An encoding longer than
64 characters becomes `item.h-<16 hex of its SHA-256>`; an id that repeats
within one fan-out gets `.2`, `.3` by occurrence. Derived from the id, not the
position, because (1) zip edges pair branches by key, so two nodes reading the
same producer through different `filter`s pair the same item, not the same
position; (2) a key names its item, so the item ids of a branch's outputs
carry provenance by themselves (`diagnose/item.validate:failure-3/diagnosis-1`);
(3) an edge `filter`/`limit`, a `dedupe` or a reordered list between producer
and consumer does not remap branches. Caveat, stated plainly: 205's ids are
positional within their producing activation, so a restarted upstream that
reorders its items gives a key to a different item. That is safe, because
such a restart supersedes the fan-out (below) and every branch, and the rerun
records a fresh fan-out; a key reused after supersession is like a reused
attempt slot.

**Item ids.** A `list<T>` element's id is its artifact's `sourceItem` (set when
an edge `flatten` cuts the elements out of a typed item list: the upstream
item's id), else the element artifact's producer label (`review/panel.2`: a
whole artifact as one item). A type with `items` gives each entry
`graphArtifactItemIds`.

**Prompt variables (105).** `{{item}}` is the element; `{{item.index}}` its
1-based position in the input list (not the branch index, which differs under
a cross product); `{{item.id}}` its stable id. These two names win over an
element field called `index` or `id` (reach those as `input.<port>.id`);
`branch.*` still names the branch.

**Per-item provenance.** Artifacts gain `sourceItem` (part of the artifact id
when present): set on `flatten` elements cut from a typed item list, on every
output of an item branch (inherited from the branch's item) and on a failed
item branch's failure marker. On an item branch the replicated port
contributes exactly the branch's item id (plus the element's own item ids) to
the citable sources, so a per-finding fix's `cite`/`accountForAll` output can
cite the finding it fixed (103's validator, unchanged). Prompts show
`Source item: <id>` after an element that has one. Merges see it: `collect`
forwards the artifacts; `concat`/`dedupe` keep item ids (which embed the key)
and `itemSources`.

**Panel and lenses.** The cross product, keys joined in axis order
(`panel.1+item.validate:failure-3`); each branch runs on the panel model or
lens role its other segments name.

**Cost bound.** Worst case `maxBranches` × the other axes × attempts ×
iterations; best case 0 branches (an empty list). The compiler's existing
cost estimate, `fanout-too-wide` (32 per node) and the limits checks use it.

**Zip over items.** Allowed between nodes whose replication signature is equal
(`items:<producer>`); branch k reads branch k by key, and a key the producer
does not have delivers nothing (the branch skips when the input is required).

**Restart and rewind (210).** Restarting one item branch keeps the fan-out:
the rerun has the same key and item. A rewind whose superseded artifacts
include one of the fan-out's sources (a restarted upstream, a rewound loop
iteration, a code rewind) supersedes the fan-out too (`supersededBy`), and the
position expands again from the live input. A user retry is a restart of a
branch.

**Run view (211) and designer (212).** Item branches share the node's column
(one group per node and iteration), each face named by its item; before the
expansion the node shows one placeholder. The designer's execution form gains
"Over list items": the input port (list ports and ports of a type with
`items`), max branches, and the truncation policy.

**Mock runs (213)** expand the same way; mock agent outputs carry `sourceItem`.

### 2026-10-29 · What was built

- **Template and plan.** `GraphReplicateAxis` items gains `truncate?: "first" | "fail"`
  (`GRAPH_ITEMS_TRUNCATE`, `template-model.ts`, validated in `template-nodes.ts`); the plan fills
  it (`compile-plan.ts`, `plan.ts`). The describe contract (215) now offers `items` replication,
  and §9.4 is among its quoted examples.
- **Compiler.** `replicate-items-unsupported` is gone; `replicate-items-input` (error, at
  `nodes[i].replicate[.axes[j]].input`) refuses an input that is neither `list<T>` nor of a type
  that declares `items` (`checkGraphItemsInputs`, `graphItemsInputHoldsItems` in
  `compile-ports.ts`). Branch bounds and costs already priced `maxBranches` (min 0); tests cover
  the cross product with a panel, `fanout-too-wide` and `limit-agent-sessions`.
- **Run record.** `GraphRun.fanOuts?: GraphItemFanOut[]` (`{nodeId, iteration, sources, items:
  GraphFanOutItem[{key, index, id, artifact}], total, truncatedIds?, createdAt, supersededBy?}`),
  bounds `maxFanOuts` 500 and `maxTruncatedItemIds` 32, validated in `run-guards.ts` (one live
  record per position). `GraphArtifact.sourceItem?` is validated and part of `graphArtifactId`
  when present. `applyGraphRewind` supersedes fan-outs cut from superseded artifacts.
- **Protocol helpers** (`run-fanout.ts`, exported from `graphs/run`): `graphNodeItemsAxis`,
  `graphItemBranchSegment`, `graphListItemCandidates`, `graphTypedItemCandidates`,
  `graphItemFanOutItems`, `graphLiveItemFanOut`, `graphRunNodeBranches(run, node, iteration)`,
  `graphActivationBranch(run, node, activation)`, `supersedeGraphItemFanOuts`.
  `graphNodeBranches(node, roles, items?)` crosses recorded items with the other axes
  (`GraphBranch.item`); without items it throws for an items axis, so callers read a run's
  branches through `graphRunNodeBranches`.
- **Runtime.** `GraphRunView.branchesAt/branchKeysAt/branchAt(node, iteration)`, `fanOutAt`,
  `addFanOut`, `typeDefinition`; the value cache carries artifact facts (`GraphLoadedValue`).
  `computeGraphReadySet` resolves an items position as a whole, then `expandGraphItems`
  (`graph-run-fanout.ts`) and creates the branches in the same round; its result has `fanOuts`
  and skip reason `no-items`. `planGraphRun` appends them (stat `fanOuts`). Edge `flatten` over a
  source type's item list keeps item ids (`GraphEdgeDelivery.store.sourceItems`), the pass stores
  them as `sourceItem`. The agent executor, the mock agent executor and the test fakes record an
  item branch's `sourceItem` on its outputs; a failed branch's marker records it too.
- **Prompts.** `GraphPromptValues.item = {index, id}`; `{{item.id}}` added; `item.index` is the
  item's position (no longer the branch index); source `item.ref`
  (`GRAPH_PROMPT_ITEM_REF_SOURCE`). `graphItemsElementType` gives the per-branch type of a
  type-with-items port. `GraphPromptElement.sourceItem` renders as `Source item: <id>` /
  `"sourceItem"`. Backend: `graphAgentItemBinding`, `graphAgentArtifactSources` (the replicated
  port cites the branch's item only; the host's light sources agree); a typed item's built-in
  prompt input is narrowed to the one entry.
- **Run view and designer.** Item branches share a column, titled `Item <id>`, with
  `fanOut {running, total}` and `item {index, id}` on flow nodes, a truncation line on the face and
  an Item section in the inspector (`graphRunTruncationText`). The Execution form edits
  `items` (`ItemsEditor`, `graphItemsInputPorts`).
- **Tests.** Protocol `run-fanout.test.ts` (keys, truncation, candidates, branches, record
  validation, rewind, `sourceItem` ids, compile bounds), `compile.test.ts`,
  `compile-diagnostics.test.ts`, `prompt-render.test.ts`, `describe.test.ts`; backend
  `graph-run-items.test.ts` (§9.4 as written end to end; the branch prompt and its citable
  source; truncate `first`/`fail`; empty list; key stability across an upstream retry, a branch
  retry, a branch restart and an upstream restart; a per-finding fix over a type with `items`
  citing its finding), `graph-mock-provider.test.ts` (§9.4 mock run as written); web
  `graph-run-flow.test.ts`, `GraphRunTab.test.tsx`, `GraphItemsEditor.test.tsx`.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Design note written; building. · Implement compiler, runtime, prompts, provenance, view, designer.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Compiler, run record, runtime expansion, prompts, provenance, mock runs, run view, designer, tests and docs. · complete; awaiting PR
- 2026-10-29 · coordinator · Split the design-note box: written, but agreement is still pending (the user's answer was never received; the build went ahead on the coordinator's recommended default). · Awaiting the user's review.
- 2026-10-29 · coordinator · The maintainer approved the design note as built (D22). · Awaiting PR.
- 2026-10-29 · coordinator · Delivered in https://github.com/orkestrator-ai/orkestrator-v2/pull/1436; status done. · None.
