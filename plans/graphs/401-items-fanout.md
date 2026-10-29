---
id: 401
title: "`items` fan-out"
phase: 4
plan: "Phase 4"
status: not-started
depends_on: [205]
blocked_by: ""
owner: ""
branch: ""
pr: ""
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

- [ ] Write the design note in this file's Notes and get it agreed before building.
- [ ] `replicate: { over: "items" }` with `maxBranches`; `{{item}}` and `{{item.index}}` in prompts.
- [ ] Per-item provenance carried through to downstream nodes.

## Tests

- [ ] The report §9.4 loop runs with `items` fan-out.
- [ ] `maxBranches` truncation is explicit, not silent.

## Done when

- [ ] `items` fan-out ships.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
