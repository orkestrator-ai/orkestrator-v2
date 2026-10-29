---
id: 210
title: "Restart and rewind"
phase: 2
plan: "P2.10"
status: not-started
depends_on: [201, 203, 204]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 210 · Restart and rewind

- **Plan:** [P2.10 Restart and rewind](../composable-graphs.md#p210-restart-and-rewind)
- **Decisions:** D8
- **Depends on:** [201](201-run-record-and-storage.md), [203](203-scheduling.md), [204](204-agent-node-executor.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Restarting or rewinding a node reruns exactly what depended on it.

## Work

- [ ] Restart a node: supersede its activation, every activation that transitively consumed its artifacts, and those artifacts; rerun it with the same inputs. Independent branches are kept.
- [ ] Inside a loop, rewind the iteration counter.
- [ ] Code rewind from the node's input `workspace@1` commit, reusing the preview, refusals, backup ref and reset in `build-pipeline-code-rewind.ts`.
- [ ] A repeated request is a no-op; restarting a superseded node is refused.

## Tests

- [ ] Independent branches survive a restart.
- [ ] Exactly the descendants are superseded.
- [ ] Code rewind preview, refusals and backup ref.

## Done when

- [ ] Restart and code rewind work from any node.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
