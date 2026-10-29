---
id: 406
title: "Coordinator authoring"
phase: 4
plan: "Phase 4"
status: dropped
depends_on: [214, 215]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 406 · Coordinator authoring

- **Plan:** [Phase 4: extensions](../composable-graphs.md#phase-4-extensions)
- **Decisions:** D6
- **Depends on:** [214](214-launch-surfaces.md), [215](215-describe-a-graph.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

The coordinator can draft templates that the user approves.

## Work

- [ ] Get a new decision recorded in the plan's Decisions table replacing D6.
- [ ] Write the design note in this file's Notes and get it agreed before building.
- [ ] Drafts created over Control MCP, untrusted until the user approves them, under the same rule as project templates.

## Tests

- [ ] A coordinator draft cannot run before approval.

## Done when

- [ ] Coordinator authoring ships under an updated D6.

## Notes

- 2026-10-29 · Dropped. The maintainer kept D6 (the coordinator launches saved templates but never creates or edits them) and dropped this item: [D24](../composable-graphs.md#decisions). The coordinator's graph tools stay `list_graph_templates`, `launch_graph`, `get_graph_run` and `cancel_graph_run`; `control-mcp-graph-tools.test.ts` asserts no authoring tool exists.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Blocked, see `blocked_by`.
- 2026-10-29 · coordinator · Dropped per D24 (D6 stands). · None.
