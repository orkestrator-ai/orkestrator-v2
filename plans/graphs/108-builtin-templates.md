---
id: 108
title: "Built-in templates"
phase: 1
plan: "P1.8"
status: not-started
depends_on: [107, 001, 003, 004, 005]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 108 · Built-in templates

- **Plan:** [P1.8 Built-in templates](../composable-graphs.md#p18-built-in-templates)
- **Decisions:** D5
- **Depends on:** [107](107-compiler.md), [001](001-pipeline-reviewers-read-only.md), [003](003-panel-review-routing.md), [004](004-typed-address-report.md), [005](005-reviewer-lenses.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

The three built-in flows are described in the template model, so users can see and duplicate them, and tests keep descriptions and engines in step.

## Work

- [ ] `graphs/builtins/multi-review.ts`, `build-pipeline.ts`, `looped-review.ts`, each with `engine` set to its engine.
- [ ] They describe the behaviour after Phase 0 (read-only reviewers, routing, typed Address report, lenses).
- [ ] Pinning tests compare each template with its engine: node set, routing conditions, iteration bounds, profiles and result kinds.

## Tests

- [ ] All three compile with no errors.
- [ ] Each pinning test fails when either side changes alone.

## Done when

- [ ] Built-in templates are merged and pinned.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
