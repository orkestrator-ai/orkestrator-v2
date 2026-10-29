---
id: 404
title: "Per-node user MCP servers"
phase: 4
plan: "Phase 4"
status: not-started
depends_on: [106, 204]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 404 · Per-node user MCP servers

- **Plan:** [Phase 4: extensions](../composable-graphs.md#phase-4-extensions)
- **Decisions:** D12
- **Depends on:** [106](106-capability-profiles.md), [204](204-agent-node-executor.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A node can be given specific user MCP servers, not just denied them.

## Work

- [ ] Write the design note in this file's Notes and get it agreed before building.
- [ ] Per-session injection of user MCP servers in each bridge (Claude, Codex, OpenCode, Cursor, Grok, Pi).
- [ ] `mcp:<server>` grants as well as denies.

## Tests

- [ ] Per-provider tests that a granted server is present and an ungranted one absent.

## Done when

- [ ] Per-node MCP servers ship on every provider that supports them, with gaps documented.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
