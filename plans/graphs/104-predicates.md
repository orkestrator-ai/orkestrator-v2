---
id: 104
title: "Predicates"
phase: 1
plan: "P1.4"
status: not-started
depends_on: [101, 102]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 104 · Predicates

- **Plan:** [P1.4 Predicates](../composable-graphs.md#p14-predicates)
- **Decisions:** D10, D14
- **Depends on:** [101](101-template-schema.md), [102](102-type-library.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Conditions for gates, `when` and loop `until`, written as JSON that forms can build and the compiler can type-check.

## Work

- [ ] `graphs/predicates.ts`: the predicate shape and guard, with operators `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`, `exists`, `empty`, `nonEmpty`, `count`, `all`, `any`, `not`.
- [ ] Paths into input artifacts, `params.*` and `run.iteration`.
- [ ] A type checker against producer schemas.
- [ ] A total evaluator: it never throws, and a missing or unknown value is false. Depth and node count are bounded.

## Tests

- [ ] Table tests per operator.
- [ ] Type-check errors for bad paths and operator mismatches.
- [ ] Evaluator totality over generated inputs.

## Done when

- [ ] Predicates are merged with tests and used by [107](107-compiler.md) and [206](206-gate-merge-loop-failure.md).

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
