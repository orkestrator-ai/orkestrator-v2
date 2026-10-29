---
id: 214
title: "Launch surfaces"
phase: 2
plan: "P2.14"
status: in-progress
depends_on: [109, 204, 211]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-214-launch"
pr: ""
updated: 2026-10-29
---

# 214 · Launch surfaces

- **Plan:** [P2.14 Launch surfaces](../composable-graphs.md#p214-launch-surfaces)
- **Decisions:** D6, D7, D17
- **Depends on:** [109](109-template-storage-and-trust.md), [204](204-agent-node-executor.md), [211](211-run-view.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Graphs can be launched from everywhere the built-in flows can, and the coordinator can use saved graphs.

## Work

- [ ] Launch dialog generated from the template: inputs, role pickers (filtered by `minEnforcement` and structured-result support), panel editors with lenses, parameters, environment choice. Defaults saved per template per project.
- [ ] "Graphs" naming; "Run graph…" in the environment action bar and on Kanban cards (ticket as input); "Run" and "Mock run" in the designer.
- [ ] CLI `orkestrator graph list | show | validate | launch | status | cancel` (`packages/cli/src/client/commands/graphs.ts`), following `docs/architecture/public-cli.md`.
- [ ] Control MCP `list_graph_templates`, `launch_graph`, `get_graph_run`, `cancel_graph_run`. No authoring (D6).
- [ ] A `graph-run` association kind beside `build-pipeline` and `multi-review` (`packages/protocol/src/coordinator.ts`), with one status wake when a run ends or waits for a person.
- [ ] Scheduled jobs can launch a saved template.

## Tests

- [ ] CLI JSON and exit-code contract tests.
- [ ] Control MCP tool tests, including refusal of authoring.
- [ ] One status wake per run end or wait.
- [ ] A scheduled launch.

## Done when

- [ ] Every entry point launches the same run, and the coordinator is woken once.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
