---
id: 205
title: "Replication and collection"
phase: 2
plan: "P2.5"
status: not-started
depends_on: [204]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 205 · Replication and collection

- **Plan:** [P2.5 Replication and collection](../composable-graphs.md#p25-replication-and-collection)
- **Decisions:** D9, D11
- **Depends on:** [204](204-agent-node-executor.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Fan-out as a node setting and fan-in as a port policy, as D9 describes.

## Work

- [ ] `replicate` over `panel`, `lenses` and `samples`, and their combinations, with at most 32 branches per node.
- [ ] Branch keys stable across retries, carried in activation keys, artifacts and item IDs.
- [ ] Collect policies: `all-settled`, `quorum`, `first` (cancels the rest), with `minSuccessful` and `includeFailures`.
- [ ] Zip edges between replicated nodes over the same branch keys.

## Tests

- [ ] Each collect policy, including failures and cancellation of the rest.
- [ ] Retrying one branch keeps its key and the others' results.
- [ ] Zip edges pair branches correctly.

## Done when

- [ ] Panels, lenses and samples run and collect as specified.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
