---
id: 002
title: "Align the iteration limit"
phase: 0
plan: "P0.2"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 002 · Align the iteration limit

- **Plan:** [P0.2 Align the iteration limit](../composable-graphs.md#p02-align-the-iteration-limit)
- **Decisions:** none (report §2.7, finding 2)
- **Depends on:** none
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

The coordinator cannot request more pipeline iterations than the protocol accepts.

## Work

- [ ] Use `MAX_BUILD_PIPELINE_ITERATIONS` in `control-mcp-coordinator-tools.ts:300` instead of the literal `20`.
- [ ] Check the other callers (CLI, launch dialog, feature builds) for literal iteration limits and point them at the constant.

## Tests

- [ ] A test pins the tool schema maximum to the protocol constant.

## Done when

- [ ] A `launch_build` call asking for 11 iterations is refused by the tool schema with a clear message.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
