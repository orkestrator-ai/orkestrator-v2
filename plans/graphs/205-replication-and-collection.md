---
id: 205
title: "Replication and collection"
phase: 2
plan: "P2.5"
status: in-progress
depends_on: [204]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-205-replicate"
pr: ""
updated: 2026-10-29
---

# 205 · Replication and collection

- **Plan:** [P2.5 Replication and collection](../composable-graphs.md#p25-replication-and-collection)
- **Decisions:** D9, D11
- **Depends on:** [204](204-agent-node-executor.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Fan-out as a node setting and fan-in as a port policy, as D9 describes.

## Work

- [x] `replicate` over `panel`, `lenses` and `samples`, and their combinations, with at most 32 branches per node.
- [x] Branch keys stable across retries, carried in activation keys, artifacts and item IDs.
- [x] Collect policies: `all-settled`, `quorum`, `first` (cancels the rest), with `minSuccessful` and `includeFailures`.
- [x] Zip edges between replicated nodes over the same branch keys.
- [x] Per-branch model bindings end to end on the agent executor (panel model per branch, a lens's own role).
- [x] One item-id derivation in the protocol, used by the agent executor, merges, prompts and provenance.
- [x] Consolidating nodes see every input item's id in their prompt; provenance accepts exactly those ids.
- [x] `report_progress` provisional items kept per branch.

## Tests

- [x] Each collect policy, including failures and cancellation of the rest.
- [x] Retrying one branch keeps its key and the others' results.
- [x] Zip edges pair branches correctly.
- [x] Panel × lenses cross product, samples, and per-branch model bindings.
- [x] Item-id helper; consolidator prompt shows item ids and provenance validation accepts them.
- [x] Seeded restart interleavings cover a replicated node and its collecting fan-in, with crashes landing mid fan-out.

## Done when

- [x] Panels, lenses and samples run and collect as specified.

## Notes

**2026-10-29 · Files.** Protocol: `graphs/run-items.ts` (new; exported from `./graphs/run`),
`run-branches.ts` (32-branch runtime guard), `prompt-scope.ts` (`GraphPromptValues.elements`,
`GraphPromptElement`), `prompt-render.ts` (item ids and failed branches in renders),
`prompt-node.ts` (lens appended when the template does not name `lens`). Backend:
`graph-run-ready-set.ts` (`collectGraphBranches`, `graphCollectPolicy`,
`graphFailureMarkersWanted`; markers kept out of edge transforms), `graph-run-scheduling.ts`
(failure markers in `failurePolicy`, `graphSurplusBranches`), `graph-run-pass.ts` (cancels
surplus branches), `graph-run-executors.ts` (cancel reason `surplus`, `GRAPH_SURPLUS_BRANCH_ERROR`),
`graph-run-transitions.ts` (`settleGraphActivation` failure `cause` optional, for a cancelled
activation's explanation), `graph-node-agent.ts` (surplus cancel message), `graph-agent-prompt.ts`
(`graphInputItemIds`, `isGraphFailureMarker`, element facts, built-in inputs), `graph-agent-host.ts`
(provenance sources), `graph-agent-results.ts` (`graphAgentItemIds` delegates), `graph-agent-tools.ts`
(`read_artifact` returns `itemIds`), `graph-node-merge.ts` (local derivation removed). Tests:
`graph-run-replication.test.ts`, `graph-node-agent-replication.test.ts`,
`packages/protocol/src/graphs/run-items.test.ts`, new cases in `prompt-render.test.ts`,
`graph-run-ready-set.test.ts`, `graph-node-merge.test.ts`; test support gained
`FakeGraphExecutors.heldBranches`, `failBranches` and `FakeExecutorCall.binding`.

**2026-10-29 · What 203/204 already did, and what was missing.** Branch keys (`panel.<n>`,
`lens.<key>`, `sample.<n>`, `+`-joined products in axis order), per-branch bindings in the pass
(`graphBranchBinding` with the branch's role; a panel axis picks the model, else a lens's role,
which the plan fills with the node's role), lens and branch values in prompts, zip delivery and
retries with the same branch key all existed; 205 adds tests for each end to end. Missing and
built here: `first` cancellation, failure markers, `first` taking the earliest finishers, the
32-branch runtime guard, the unified item ids, item ids in user-template prompts, and lens text
for templates that never name `lens`.

**2026-10-29 · Unified item ids (resolves the 204/206 conflict).**
`<node>[/iter-<n>][/<branch>]/<idPrefix>-<k>` (206's form: slash segments, closest to today's
`reviewer-{pos}/issue-{n}` and §5.8). `k` is 1-based, the iteration segment from iteration 2, the
branch segment only for a replicated branch; the attempt is never part, so a retry keeps its
ids. At most 128 characters: a long branch becomes `b-<12 hex>`, a still-long label `<16 hex>`
(both SHA-256, stable). Run inputs read as `$input/<port>/…`. API (`@orkestrator/protocol/graphs/run`):
`graphItemIds(owner, idPrefix, count)`, `graphItemIdLabel`, `graphItemList(items, value)`,
`graphItemIdOwner(producer)`, `graphArtifactItemIds(artifact, items, {value?|count?})` (recorded
`itemIds` when they match the count, else derived), `graphAcceptedItemIds(items, value, owner)`
(what the agent executor records at accept time), `GRAPH_ITEM_ID_MAX_CHARS`. 204's
`<node>.<branch>@<iter>` form is gone; recorded ids from it would still be honoured (recorded
wins when the count matches).

**2026-10-29 · Item ids in prompts.** The executor passes `values.elements[port]` (one entry per
artifact: `itemIds` from `graphArtifactItemIds`, or `failure: true` for a marker). `json-frame`
adds `"sourceId"` as the first key of every item object (the values are cloned, not changed);
`markdown` and `summary` follow each element with `Source ids (one per item, in order): …`. The
provenance sources (`loadGraphAgentInputs` and the host's light path) come from the same helper,
so a consolidator may cite exactly the ids it was shown (tested on the real executor: a bogus id
is refused with "The source does not identify an item in the node's inputs."). `read_artifact`
returns `itemIds` too. Lists of lists get no element facts (ids belong to the innermost artifacts).
A preview has none.

**2026-10-29 · Collect semantics** (`collectGraphBranches`; header of `graph-run-ready-set.ts`).
`all-settled`: waits for every branch, delivers every success in branch order. `quorum`: delivers
at `count` successes (every success known then, branch order); other branches keep running.
`first`: delivers the first `max(min(count, branches), minSuccessful)` successes by `finishedAt`
(branch order breaks ties), listed in branch order. Fewer than `minSuccessful` possible successes
fail the port (`system-error`, "<k> of <n> branches succeeded; at least <m> are required").
Markers never count as successes. All branches skipped → absent (206's rule, kept).

**2026-10-29 · Failure markers.** A replicated node's terminally failed branch (no retry left,
`onFailure` not `fail-run`) gets an `error@1` artifact recorded as its `error` output when some
fan-in edge (not zip) or loop carry reading the node has `includeFailures` (the plan default is
true) — the same request path and value as 206's `route` (`graphRoutedErrorValue`; producer port
`error`). A `route` node's routed error doubles as the marker. `includeFailures` lists put markers
at the failed branch's position; `all-settled` waits until they are stored, `quorum`/`first` take
those already stored. Edge transforms never see markers (they follow the transformed values).
Merges skip them (206). Agent prompts render them as failed branches (`{"branchFailed": …}` /
"Branch failed (<cause>): <message>"); built-in prompt builders do not receive them (today's
builders take reports only). Run outputs never include markers. A marker that cannot be stored
fails the run (`system-error`), as a route does.

**2026-10-29 · `first` cancels the rest** (`graphSurplusBranches(run)`). The not yet terminal
activations of a replicated node at an iteration are surplus once every reader of the node is a
non-zip fan-in edge into a `first` port that already has its successes. Any other reader (a zip
edge, an `all-settled`/`quorum` port, a carry, a run output, a loop `until` reading the node)
keeps every branch. The pass settles unadmitted surplus `cancelled` (error
`GRAPH_SURPLUS_BRANCH_ERROR`, no cause, never started) and stops admitted ones through
`executor.cancel(ctx, "surplus")`, re-asking on later passes until confirmed (3 attempts, then
settled as for other cancels). Cancelled branches are absent, so a later re-resolution still
finds the same successes.

**2026-10-29 · Lens text.** A user template that names `lens` places it itself (the linter
already warns when a per-branch variable precedes a large shared input). One that never names
`lens` gets `Lens: <label>\n\n<instruction>` appended at the end of the user part
(`graphPromptLensText`), so every branch shares the cached prefix before it; the designer's
preview shows the same.

**2026-10-29 · For later items.** 210: a rewind or restart of one branch keeps its branch key and
therefore its item ids; superseding a failed branch should also drop its `error` marker
(recreated on the next failure). Surplus-cancelled activations are `cancelled` with
`GRAPH_SURPLUS_BRANCH_ERROR` (or the executor's error) — not failures. 211: per-branch progress is
`activation.session.progress` of each branch activation (dropped when its result is accepted);
markers are `error@1` artifacts whose producer port is `error` on a failed branch; show surplus
cancellations distinctly (`error === GRAPH_SURPLUS_BRANCH_ERROR`). 213: mock executors receive
cancel reason `surplus`; `FakeGraphExecutors` gained `heldBranches`/`failBranches`. 301: the
built-in consolidation prompt does not list failed reviewers (markers are filtered out of
built-in inputs); add them to `createMultiReviewConsolidationPrompt` if parity needs the
"sessionless reviewer" summaries; item ids now match `review/panel.<n>/issue-<k>`. 216: document
the item-id grammar, collect semantics and markers in `docs/architecture/graphs.md` (it has no
runtime section yet; not written here).

**2026-10-29 · Restart mid fan-out: seeded interleavings** (Phase 2 exit criterion "A backend
restart in the middle of a fan-out recovers without re-dispatching. Interleaving seeds cover
activations."; branch `graphs-limits-schedules`).
`apps/backend/src/core/graph-node-agent-interleaving.test.ts` (204's seeded harness on the real
agent executor, provider and dispatch journal) now picks one of two shapes per seed: the
independent steps it had, or a fan-out: a replicated agent node `fan` (`panel` over 2–4 bound
models, or `lenses` with 2–4 lenses) whose branches an agent `gather` collects (`list<…>` input,
`collect: {wait: all-settled, minSuccessful: 1}`). Every branch and the collector get a script
(complete, end without the result, cut short by a provider restart, fail). A fan-out seed always
dies once during the branches' dispatch (operation 1..branches: sends race under the 4-start cap,
so the crash lands while other branches are journaled, sending or running) and may die again
anywhere later, the collector included; a crash may land the prompt anyway (late delivery) or
have the provider retire it as lost. Invariants on every seed: journal before send; no request
runs twice and no step or branch runs its original turn twice (branches identified by their lens
or panel model); every run ends; every completed step, branch and collector has verified
outputs; the collector received exactly the branches that completed (each verified); failures are
explained by a script, a disruption or a collect shortfall. A coverage test asserts both axes,
mid fan-out crashes and a collector completing after one. Default seeds raised from 16 to 24
(about 2 s). Local run: `ORKESTRATOR_FANOUT_INTERLEAVING_SEEDS=3000` passed 3002/3002 (seeds
1–3000, 114 s): 1498 fan-out seeds (724 panel, 774 lenses), every one with a crash while a branch
was unsettled, 1105 of them with the collector completing afterwards; 3115 crashes, 974 late
deliveries, 234 lost answers. A branch whose dispatch a crash left unprovable fails as
"acceptance could not be confirmed" rather than being sent again; that is the at-most-once rule,
not a regression.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Collect policies with failure markers and `first` cancellation, unified item ids in protocol (executor, merges, prompts, provenance), item ids in consolidator prompts, lens text for templates without `lens`, 32-branch runtime guard; tests incl. real agent executor. · complete; awaiting PR
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Seeded interleavings extended to a replicated node (panel/lenses, 2–4 branches) with a collecting fan-in and crashes mid fan-out; 3000 seeds pass locally; Phase 2 exit criterion ticked. · complete; awaiting PR
