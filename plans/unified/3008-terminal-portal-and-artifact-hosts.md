---
id: 3008
title: "Node-qualified terminalPortalStore and artifactLiveHostStore"
phase: 3
plan: "§7.1 class (d) and §12 Phase 3.3"
status: not-started
depends_on: [3001, 3016]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3008 · Node-qualified terminalPortalStore and artifactLiveHostStore

- **Report:** [§5.1](../../docs/reports/unified-federation.md#51-scopes) (the terminal DOM registry is window-owned), [§7.1](../../docs/reports/unified-federation.md#71-inventory)
- **Depends on:** [3001](3001-scoped-store-shim-and-ratchet.md), [3016](3016-rich-content-and-caches.md) (`artifactLiveHostStore` imports `rich-content-reset`)
- **Blocks:** [3010](3010-sessions-terminals-tmux-mail.md), [3013](3013-pane-layout-store.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

The terminal DOM registry and live artifact hosts stay window-owned, because a DOM node exists once per window. Their keys carry the node, because terminal keys use host-local container ids that can repeat across nodes.

## Current state (verified 2026-11-07)

- `terminalPortalStore`: 368 LOC, 6/4 imperative sites. `paneLayoutStore` calls it.
- `artifactLiveHostStore`: 364 LOC, 5 sites. It imports `rich-content-reset`.

## Work

- [ ] Change keys to `{ nodeId, key }`, encoded as `${nodeId}\u0000${key}` or a nested map. Every producer passes the scope's node id.
- [ ] Byte-bounded artifact hosts reserve from the window `ByteBudget` ([2001](2001-node-scope-core.md)) with node-qualified keys.
- [ ] Disposing a scope releases its terminal portals and artifact hosts.

## Tests

- [ ] Two nodes with the same container-derived terminal key get two portals, and disposing one node releases only its own.

## Done when

- [ ] Both stores are node-qualified, and the existing terminal and artifact suites pass.
