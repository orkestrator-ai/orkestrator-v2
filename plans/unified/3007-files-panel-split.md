---
id: 3007
title: "Split filesPanelStore and convert projectPullRequestsStore"
phase: 3
plan: "§7.1 class (d) and §12 Phase 3.3"
status: not-started
depends_on: [3001, 3002, 3015]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3007 · Split filesPanelStore and convert projectPullRequestsStore

- **Report:** [§7.1](../../docs/reports/unified-federation.md#71-inventory)
- **Depends on:** [3001](3001-scoped-store-shim-and-ratchet.md), [3002](3002-lib-backend-client-parameter.md), [3015](3015-persistence-keys-per-node.md)
- **Blocks:** [3013](3013-pane-layout-store.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

The files panel's open state and width are per window. Its folders, PR tabs and selection are per node.

## Current state (verified 2026-11-07)

- `filesPanelStore`: 445 LOC, 20/11 imperative sites, 15 direct importers, 26 test files. It uses `persist` keyed by `desktopConnectionStorageKey`.
- `projectPullRequestsStore` (173 LOC, 0 sites) imports a type from it, persists, and is keyed the same way.
- `hooks/useFilesPanel.ts` has 16 sites and per-project maps (Appendix B).

## Work

- [ ] Window store `filesPanelChromeStore` (open, width), shared by all nodes as today.
- [ ] Scoped `filesPanelStore` for folders, PR tabs and selection. Scoped `projectPullRequestsStore`.
- [ ] `useFilesPanel` maps per scope.

## Tests

- [ ] Opening the panel on one node opens it for all; folder expansion stays per node; persistence keys are per node.

## Done when

- [ ] Both stores are converted, and the files panel works for the command scope.
