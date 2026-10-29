---
id: 216
title: "Documentation"
phase: 2
plan: "P2.16"
status: in-progress
depends_on: [201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-216-docs"
pr: ""
updated: 2026-10-29
---

# 216 · Documentation

- **Plan:** [P2.16 Documentation](../composable-graphs.md#p216-documentation)
- **Decisions:** none
- **Depends on:** [201](201-run-record-and-storage.md), [202](202-supervisor-domain.md), [203](203-scheduling.md), [204](204-agent-node-executor.md), [205](205-replication-and-collection.md), [206](206-gate-merge-loop-failure.md), [207](207-system-nodes.md), [208](208-human-nodes.md), [209](209-guards-and-enforcement.md), [210](210-restart-and-rewind.md), [211](211-run-view.md), [212](212-editable-designer.md), [213](213-mock-runs.md), [214](214-launch-surfaces.md), [215](215-describe-a-graph.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Shipped behaviour is described in living docs, not only in this folder.

## Work

- [x] `docs/architecture/graphs.md`: model, compiler, runtime, artifacts, profiles and tiers, guards, storage, bounds, invariants.
- [x] `docs/architecture/graphs-user-guide.md`: designing, testing with mock runs, launching, watching, restarting.
- [x] Rows for both in `docs/README.md`.
- [x] Update `coordinator.md` (graph tools and wakes), `public-cli.md` (graph commands) and `agent-engines.md` (new capabilities).

## Tests

- [x] `bun test tests/unit/mise-tasks.test.ts` and the docs tests pass.

## Done when

- [x] The living docs describe everything Phase 2 shipped.

## Notes

- Write sections as items land rather than all at the end; this item is done when the last one is covered.
- 2026-10-29 · **What was written.** `docs/architecture/graphs.md` rewritten into one living doc
  from the code and every item's Notes (it had grown by merges with both sides kept: the describe
  and mock-run rows sat outside the parts table, the overview still said duplicates run "once Phase
  2 ships it", and sections were in merge order). Order now: overview and module map, the template
  model (items fan-out, sub-graphs, isolation), types and the schema subset, predicates, prompts and
  the locked system contract, capabilities (profiles, tiers, per-node MCP), the compiler (diagnostic
  families with a link to `GRAPH_COMPILE_DIAGNOSTICS`, taint, cost, plan digest), built-ins,
  library/trust/sharing, storage, the runtime (supervisor domain, a pass, scheduling, executors, the
  agent executor with result slots and `ask_human`, gates/merges/loops/failure, system nodes with
  effect keys and provisioning, human nodes, guards, isolated worktrees, restart and rewind, mock
  runs), launching, describe a graph, the designer (canvas decision kept under its old heading so
  the 000-index anchor still resolves), the run view, a placeholder heading for item 301, a bounds
  table of every named bound constant, the nine invariants with how each is upheld, and known gaps.
  New `docs/architecture/graphs-user-guide.md`. Rows for both in `docs/README.md`.
- 2026-10-29 · **Inaccuracies fixed in `graphs.md`.** Mock-run navigation: the terminal container,
  not the run view, registers `onGraphRunViewRequested`. Gate with no true branch and no
  `otherwise` completes with no outlet (consumers skip), it does not fail. Cancel reasons are
  `run-cancelled`, `run-failed`, `timeout`, `surplus`, `restarted`. Replicated nodes default to
  `onFailure: skip`. `graph_run_answer` returns `{activationKey, question|human}`. Admission blocks
  are `concurrency`, `workspace-lock`, `worktree-limit`, `recovering`. `graphTemplateDigest` drops
  `mockPins` as well as `layout`. `capability-mcp-grant` is a warning (not an error). Every system
  action but `wait-for-checks` has `sideEffect`; `open-pull-request` also reports
  `pull-request-state@1` (a custom type the template declares).
- 2026-10-29 · **Inaccuracies fixed elsewhere.** `coordinator.md`: side agents hold `discovery`,
  `mail` and `schedules`; the graph reducer is `graphRunCoordinatorStatus` with wait key
  `waiting:<openedAt>:<id>` and terminal keys `complete|failed|cancelled` (not `ended:<status>`);
  failed notices carry the error only; no 20 s debounce for graph waits; new "Saved graphs" section
  (the four tools, gating, admission before launch, no authoring, scheduling). `public-cli.md`:
  `graph validate` exits 0 even for an unparsable document; an environment of another project is
  `invalid-input` (exit 2); paging flags, request-key derivation, `graph status` fields and the
  `graph cancel` refusal added. `agent-engines.md`: turn mode is keyed on the compiled policy
  (`nativeAgentDenialsAreReadOnly`), not on `workspaceAccess`; `gh` rules for `github.write`; Git
  and GitHub denials held by shell denial, then Claude/OpenCode rules, then the guards
  (`nativeAgentCapabilityHold`); OpenCode result tools `submit_graph_output` and
  `validate_workflow_result`. `mcp-management.md` link updated to the new anchor.
- 2026-10-29 · **Found while documenting (not fixed; recorded under Known gaps).** `limits.maxTokens`
  and `limits.maxWallClockMs` are compiled and shown but no backend code enforces them (the
  template model calls them a "soft runtime meter"). No CLI flag or Settings form creates a `graph`
  schedule action. The human-node inactive-environment path has no real-stack run yet (the run
  view's has: `graph-run-view.spec.ts`).
- 2026-10-29 · The first two are fixed on branch `graphs-limits-schedules`: the limits are enforced
  ([203](203-scheduling.md) Notes, "Token and wall-clock limits") and graph schedules are created
  from the CLI and Settings ([214](214-launch-surfaces.md) Notes, "Graph schedules in the CLI and
  Settings"); `graphs.md` (Limits, Scheduling, Launch surfaces, Known gaps), the user guide,
  `scheduled-jobs.md` and `public-cli.md` describe them.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Rewrote graphs.md as one living doc, added the user guide and README rows, verified and fixed coordinator.md, public-cli.md and agent-engines.md. · complete; awaiting PR
