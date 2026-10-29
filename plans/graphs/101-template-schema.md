---
id: 101
title: "Template schema"
phase: 1
plan: "P1.1"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 101 · Template schema

- **Plan:** [P1.1 Template schema](../composable-graphs.md#p11-template-schema)
- **Decisions:** D2, D8, D9, D10
- **Depends on:** none
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A versioned, bounded JSON shape for graph templates, with guards, that every later item builds on.

## Work

- [ ] `packages/protocol/src/graphs/template.ts`: `GraphTemplateV1` with parameters, roles, types, inputs, workspace, nodes (`agent`, `system`, `gate`, `merge`, `human`, `subgraph`), edges, loops, limits and layout (report §4.5).
- [ ] Hand-written guards in the protocol's style; an ID and label grammar; byte and count bounds on every string and list.
- [ ] `subgraph` is accepted by the schema; the compiler rejects it until [402](402-subgraphs.md).
- [ ] Role `defaultsFrom` names `ActionDefaultKey` values. Panel positions beyond the second come from `MultiReviewAgentSettings.additionalReviewers`.
- [ ] Export the module from the protocol package.

## Tests

- [ ] The guard accepts the example templates in report §9.
- [ ] The guard rejects each malformed shape and every bound overrun.

## Done when

- [ ] Schema and guards are merged with tests, and the shape is described in this file's notes until [216](216-documentation.md) writes the living doc.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
