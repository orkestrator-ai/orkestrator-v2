---
id: 5007
title: "Warm and live scopes overlay their summary rows"
phase: 5
plan: "§5.1, §9 (Sidebar) and §12 Phase 5"
status: not-started
depends_on: [4002]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 5007 · Warm and live scopes overlay their summary rows

- **Report:** [§5.1 Scopes](../../docs/reports/unified-federation.md#51-scopes), [§9 Cross-node features](../../docs/reports/unified-federation.md#9-cross-node-features) (the Sidebar row)
- **Depends on:** [4002](4002-hydration-tiers-and-budgets.md) (tiers)
- **Size:** S–M
- **Track:** S (scopes)

## Goal

The sidebar, ⌘K search and title-bar readings show a warm or live node from its scope's full stores, and every other node from summaries, as §9's Sidebar row describes ("Summaries for every node; full scope stores overlay warm/live nodes; parity tests kept and extended to 'same row from summary vs scope'").

## Current state (verified 2026-11-07)

Found while doing [6004](6004-documentation.md): the sidebar, ⌘K search and title-bar readings use summaries only, whatever the node's tier. `docs/architecture/federation.md` lists this under known limitations.

## Work

- [ ] In the presentation path (`docs/architecture/federation.md#one-presentation-for-both-paths`: `lib/federation/aggregate.ts`, `node-summaries.ts`, `MachineView`), take a node's rows from its scope's project and environment stores while the scope is `warm` or `live`, and from its summary otherwise. Switching tiers must not flicker or reorder rows.
- [ ] Apply the same rule to ⌘K search and the title-bar readings that read per-node data.
- [ ] Remove the known-limitation line from `federation.md` and describe the overlay.

## Tests

- [ ] Parity: the same row rendered from a summary and from a scope is identical (extend the existing parity tests).
- [ ] A tier change from summary to warm and back keeps the row stable; a scope's fresher data (an environment renamed in the scope) shows without waiting for the next summary.

## Done when

- [ ] Warm and live nodes' rows come from their scopes, with the parity tests passing.

## Notes

- 2026-11-07 (orchestrator): created from 6004's finding that the §9 overlay was never assigned to an item.

## Work log
