---
id: 206
title: "Gate, merge, loop and failure handling"
phase: 2
plan: "P2.6"
status: in-progress
depends_on: [104, 203]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-206-control"
pr: ""
updated: 2026-10-29
---

# 206 · Gate, merge, loop and failure handling

- **Plan:** [P2.6 Gate, merge, loop and failure handling](../composable-graphs.md#p26-gate-merge-loop-and-failure-handling)
- **Decisions:** D10, D11, D14
- **Depends on:** [104](104-predicates.md), [203](203-scheduling.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Deterministic control flow over typed data.

## Work

- [x] Gates evaluate predicates; branches not taken mark their subtree `skipped`.
- [x] Merges `concat`, `dedupe` (by key path, keeping every source ID), `vote` (with a tie policy), `best`, `collect`.
- [x] Loops with `until`, `maxIterations`, carried ports and `firstIterationFrom`; the iteration index is part of the activation key.
- [x] `retry` (attempts and which failures count), then `onFailure`: `fail-run` (default for writers), `skip`, or `route` emitting `error@1`.
- [x] Edge transforms (`pick`, `filter`, `limit`, `flatten`, `adapt`) applied to delivered values, and the runtime budget check of `budgetCheck` edges (102's open runtime half).

## Tests

- [x] Gate routing and skip propagation.
- [x] Each merge strategy, including ties and empty inputs.
- [x] Loops converge, stop at their bound, and carry the right artifacts.
- [x] Each failure mode.

## Done when

- [x] Gates, merges, loops and failure handling behave as specified.

## Notes

**2026-10-29 · Files.** Backend: `graph-node-gate.ts` (`createGraphGateExecutor`,
`chooseGraphGateOutlet`, `graphGateInputRoots`), `graph-node-merge.ts` (`createGraphMergeExecutor`,
pure `mergeGraphValues`, `graphArtifactItemIds`), `graph-edge-transforms.ts` (pure; below). Changed:
`graph-run-ready-set.ts`, `graph-run-scheduling.ts`, `graph-run-pass.ts`, `graph-run-view.ts`,
`graph-run-loops.ts`, `graph-artifacts.ts` (`itemSources` input), `index.ts` (registers the gate and
merge executors; mock runs use them too). Protocol: `GraphArtifact.itemSources` (run-model, guard,
limit). Tests: `graph-run-control.test.ts` (service passes with the real gate and merge and scripted
fakes), `graph-node-merge.test.ts`, `graph-node-gate.test.ts`, `graph-edge-transforms.test.ts`, new
cases in `graph-run-ready-set.test.ts` and `run.test.ts`. Test support: `FakeGraphExecutors` gained
`skipKinds` (leave kinds to real executors), `scripts` (output value per port, iteration, branch;
`null` = not produced) and `failQueue` (causes for successive starts).

**2026-10-29 · Gates.** Branches in order through `evaluateGraphPredicate` over the gate's inputs
(by port; a list input is the list of values; only roots the branches read are loaded and
verified), `params` and `run.iteration`; the first *definitely true* branch wins, else
`otherwise`; with neither the gate completes **without an outlet** (every outlet's consumers skip;
the fake gate now does the same instead of failing). Outputs = forwarded single-value inputs; the
ready set delivers a taken outlet's port from `outputs[port] ?? inputs[port]`, so list inputs pass
through as lists (human `edit` outlets can still override via outputs). Skip propagation is the
dataflow's (203): verified with exclusive producers (publish after fix | clean), a node needing both
outlets (always skipped) and whole subtrees. **Fix:** a fan-in whose branches were *all skipped* is
now `absent` (skip propagates) instead of failing its collect policy (`minSuccessful`), which
otherwise failed the §9.4 round after validation came back clean.

**2026-10-29 · Merges** (`mergeGraphValues`; pure, deterministic, input order breaks every tie).
Inputs deduplicated by artifact id; `error@1` failure markers (205's `includeFailures`) ignored
except by `collect`. `concat`: first input with its `items` list replaced by every input's items;
`itemIds` kept. `dedupe` (D11): items grouped by canonical JSON of the key paths (an item missing
every key path is never folded); first item of a group kept under its id; `itemSources[i]` = every
folded item id; when the item type has a direct `x-orkestrator-sources` field (a finding's
`reviewSourceIds`) it gets the union of the folded items' cited sources (or their own ids), capped
at the type's `maxItems`. `vote`: plurality of the text at `path` (default `choice`); inputs
without one abstain; tie `fail` → `invalid-result`, `first` → first-seen choice; output = the first
winning input, `rationale` (when a string) prefixed with `Vote: a 2, b 1 (3 votes[; tie broken by
input order]).`, cut to the string budget. `best`: highest (or `prefer: lowest`) finite number at
`score`; earliest wins ties; none scored → `invalid-result`. `collect`: stores nothing; the ready set
delivers the merge's input list. **Empty input** (or markers only) → completes without its output
(consumers skip; a required run output from it is then missing). Output stored as the output
port's type with producer = the merge activation and lineage = all inputs. Item ids:
recorded `itemIds` when they match the item count, else `<node>[/iter-<n>][/<branch>]/<idPrefix>-<k>`
(1-based; duplicates suffixed `~2`).

**2026-10-29 · Edge transforms at delivery** (`graph-edge-transforms.ts`).
`applyGraphEdgeTransforms(value, transforms, {list})` → `{ok, value, list}` |
`{ok:false, code, index, message}`; `planGraphEdgeDelivery({plan, edge, port, sources:[{id,value}]})`
→ `forward {ids}` (only filter/limit ran: the same artifacts) | `store {type, values, inputs}` (new
artifacts of the port's element type) | `failed {cause: budget-exceeded|system-error, message}`;
`graphEdgeNeedsDelivery(edge)` = transforms or `budgetCheck`. The source is a list when the edge's
`sourceType` is. Bounds: 10,000 elements in flight, 256 artifacts per port (else `budget-exceeded`,
"add a limit transform"). The budget check (`graphBudgetIssues` with the target element type) runs
on every delivered value of such an edge. Ready-set integration: a position is first judged on raw
sources; deliveries are made only once no input is pending or absent (a node skipped for an absent
input stores nothing; `when` then reads the delivered values). The ready set
asks for source values (`needValues`) and for new artifacts (`GraphArtifactRequest`, returned as
`needArtifacts` by `planGraphRun`); the pass stores them (`putValue`, which validates the full type)
and plans again; outcomes are memoised per pass in `GraphArtifactOutcomes` keyed by consumer
activation + edge + source ids. Derived artifact producer = `{nodeId: consumer, activation:
consumer key, port: input port}`, lineage = the source ids. A failed delivery fails the consumer
position with that cause (its `onFailure` applies). `graphRunSettled` also waits on
`needArtifacts`.

**2026-10-29 · Loops** (`graph-run-loops.ts`). `graphLoopState` → `done` now carries `reason`
(`converged` | `bound` | `not-entered`) and `iteration`; `until` is evaluated at the bound too, so a
last iteration that converges reports `converged`. **Stopping at `maxIterations` is an outcome, not
a failure:** the loop is done and everything after it (run outputs included) reads the last
iteration's artifacts; a template that must treat non-convergence differently gates afterwards on
the artifact its `until` reads. Carries read the producer's latest live activation of the previous
iteration (**fix:** a carry from a replicated producer now collects its branches instead of waiting
forever). The iteration is in every key (`prepare#iter=2#attempt=1`). Tested on the §9.2 shape
(converges at 2; bound at 3) and §9.4 with a static panel (flatten at delivery → dedupe → fix →
revalidate; converges when failures are empty). (2026-10-29: since item 401 §9.4 also runs as
written, with `items` fan-out, in `graph-run-items.test.ts`; the static-panel test stays as panel
coverage.)

**2026-10-29 · Failure** (`graph-run-scheduling.ts` header). Retry while `attempts` allow and the
cause is in `retry.on` (only `provider-error`, `invalid-result`, `timeout` can be); same inputs, new
attempt. Then `fail-run` (default unless replicated) fails the run; `skip`: the failed activation
delivers nothing; `route`: unless the executor reported one, planning requests an `error@1`
(`{node, cause, code: cause with "_", message: activation error ≤1,300 chars, attempts, retryable:
cause is a retry cause}`, producer `{node, failed key, "error"}`, lineage = its inputs) and records
it as `outputs.error`; `error` consumers wait (pending) until it is stored, other consumers skip; on
success nothing is emitted on `error`. A failed activation now delivers only its `error` port
(earlier any reported output). A route whose artifact cannot be stored fails the run
(`system-error`). Merges cannot route (one output port; compiler).

**2026-10-29 · For later items.** 205: fan-in failure markers should be `error@1` artifacts in the
list (merges skip them, `collect` keeps them); keep `graphArtifactItemIds` in step if branch keys or
recorded item ids change; set `itemIds` at accept time (204/205) with the same derivation. 210:
derived (transform) artifacts and routed errors are recreated per new activation key; superseding
consumer activations is enough. 211: `graphLoopState(view, loop)` gives the loop outcome and
reason; artifacts whose producer port is an *input* port of the producing node are edge-transform
deliveries; `itemSources` shows dedupe folds; `GraphRunPassStats.artifactsStored`. 213: gates and
merges are live executors registered in `index.ts`; mock runs resolve them unless a mock is
registered.

**2026-10-29 · Audit: `onFailure` default for writers.** Replicated nodes
defaulted to `skip` even when they were (isolated) writers, while P2.6 makes
`fail-run` the default for writers. `compile-plan.ts` now defaults a node whose
workspace access is `write` (isolated replicated writers included) to
`fail-run`, and keeps `skip` for replicated readers and nodes without workspace
access. No built-in or example template's plan changed; the competing
implementations example (403) now states `onFailure: "skip"` on its builders,
since its judge picks among the builders that succeeded. Test:
`isolation.test.ts` ("writers default to fail-run, isolated replicated ones
too").

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Gate and merge executors, edge transforms and budget checks at delivery, routed `error@1`, loop done reasons, skip and carry fixes in the ready set, `itemSources`; tests. · complete; awaiting PR
- 2026-10-29 · Claude Opus 5.5 (graphs-audit-fixes) · writers default to `fail-run`, replicated readers keep `skip` · awaiting PR
