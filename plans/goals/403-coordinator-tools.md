---
id: 403
title: "Coordinator tools"
phase: 4
plan: "P4.3"
status: not-started
depends_on: [402]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 403 · Coordinator tools

- **Plan:** [P4.3 Coordinator tools](../goals.md#p43-coordinator-tools)
- **Decisions:** D4
- **Depends on:** [402](402-public-cli-and-api.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A coordinator can give a worker a goal and be woken when it ends.

## Work

- [ ] Tools to set, read, pause and clear a goal on a worker the coordinator owns.
- [ ] One wake when the goal ends or pauses (shared with 204).
- [ ] Update `docs/architecture/coordinator.md` and `coordinator-providers.ts` qualification as its rules require.

## Tests

- [ ] Control MCP tests, including a refused call for a tab the coordinator does not own.

## Done when

- [ ] A live coordinator run delegates a goal and reacts to its end.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
