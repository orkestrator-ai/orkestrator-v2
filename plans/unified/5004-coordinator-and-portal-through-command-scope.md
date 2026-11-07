---
id: 5004
title: "Coordinator gate, machine invoke and portal APIs through the command scope"
phase: 5
plan: "§5.1 Command scope and §9"
status: not-started
depends_on: [4001]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 5004 · Coordinator gate, machine invoke and portal APIs through the command scope

- **Report:** [§5.1](../../docs/reports/unified-federation.md#51-scopes), [§9](../../docs/reports/unified-federation.md#9-cross-node-features)
- **Depends on:** [4001](4001-in-tree-workspace-seam.md)
- **Blocks:** [6001](6001-in-tree-by-default.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

What a realm reaches through `window.orkestratorPortal` today becomes a call on the command scope. The `portalInvoke`/`portalListen` split disappears.

## Current state (verified 2026-11-07)

- `lib/portal/portal-transport.ts` (56 LOC; test 106 lines) holds `portalInvoke`, `portalListen` and `portalListenAuthoritative`, using `window.orkestratorPortal` with the global as fallback.
- `LeafModeCoordinatorGate.tsx` (:58-110) uses the portal `self` summary and realm grouping.
- `machineInvoke`: `null` means portal, `undefined` means workspace, and an id means `invokeOnNode`.

## Work

- [ ] Make portal APIs command-scope calls: inherited settings, the node registry, grants, portal layout, project copy, outcomes, action requests and handover.
- [ ] `LeafModeCoordinatorGate` reads grouping from `machineViewStore` and the command scope.
- [ ] `machineInvoke(nodeId)` → `scope(nodeId).client.invoke` for warm and live nodes, or `invoke_on_node` through the command scope for summary-tier nodes. Used for agent accounts and MCP per machine.
- [ ] `portal-transport.ts` becomes a thin command-scope adapter, deleted in [6002](6002-delete-web-realm-code.md).

## Tests

- [ ] `leaf-mode-coordinator-gate.test.tsx` (434 lines) ported; `machineInvoke` per tier; project copy across nodes.

## Done when

- [ ] No in-tree code reads `window.orkestratorPortal`.
