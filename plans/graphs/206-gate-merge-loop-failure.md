---
id: 206
title: "Gate, merge, loop and failure handling"
phase: 2
plan: "P2.6"
status: not-started
depends_on: [104, 203]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 206 · Gate, merge, loop and failure handling

- **Plan:** [P2.6 Gate, merge, loop and failure handling](../composable-graphs.md#p26-gate-merge-loop-and-failure-handling)
- **Decisions:** D10, D11, D14
- **Depends on:** [104](104-predicates.md), [203](203-scheduling.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Deterministic control flow over typed data.

## Work

- [ ] Gates evaluate predicates; branches not taken mark their subtree `skipped`.
- [ ] Merges `concat`, `dedupe` (by key path, keeping every source ID), `vote` (with a tie policy), `best`, `collect`.
- [ ] Loops with `until`, `maxIterations`, carried ports and `firstIterationFrom`; the iteration index is part of the activation key.
- [ ] `retry` (attempts and which failures count), then `onFailure`: `fail-run` (default for writers), `skip`, or `route` emitting `error@1`.

## Tests

- [ ] Gate routing and skip propagation.
- [ ] Each merge strategy, including ties and empty inputs.
- [ ] Loops converge, stop at their bound, and carry the right artifacts.
- [ ] Each failure mode.

## Done when

- [ ] Gates, merges, loops and failure handling behave as specified.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
