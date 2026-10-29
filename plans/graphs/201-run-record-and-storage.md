---
id: 201
title: "Run record and storage"
phase: 2
plan: "P2.1"
status: not-started
depends_on: [107]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 201 · Run record and storage

- **Plan:** [P2.1 Run record and storage](../composable-graphs.md#p21-run-record-and-storage)
- **Decisions:** D7, D8
- **Depends on:** [107](107-compiler.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A durable, bounded run record and artifact store that every runtime item reads and writes.

## Work

- [ ] `packages/protocol/src/graphs/run.ts`: `GraphRun`, `NodeActivation`, `GraphArtifact` (report §5.4, §8.1).
- [ ] Stores `graph-runs` (revision compare-and-swap) and `graph-artifacts` (value artifacts by digest, with lineage).
- [ ] Reference artifacts under `.orkestrator/graph-artifacts/<run-id>/`, hash-verified before each consumer, inside containers too (reuse the review package's `sha256sum` path).
- [ ] Budgets: 32 MiB inline and 256 MiB on disk per run; bounded activation history; at most 50 rewinds.
- [ ] Each activation records the policy and enforcement tier it actually got.
- [ ] Environment deletion removes run artifacts (`docs/architecture/environment-deletion.md`).

## Tests

- [ ] Compare-and-swap conflicts.
- [ ] Every bound refuses overruns explicitly.
- [ ] A tampered reference artifact fails verification.
- [ ] The container path verifies inside the container.
- [ ] Deleting the environment removes its artifacts.

## Done when

- [ ] Runs and artifacts persist, reload and stay within their bounds.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
