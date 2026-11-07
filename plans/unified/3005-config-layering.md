---
id: 3005
title: "configStore per node with effectiveConfig(scope) layering"
phase: 3
plan: "§9 Settings layering and §12 Phase 3.2"
status: not-started
depends_on: [3001, 3002]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3005 · configStore per node with effectiveConfig(scope) layering

- **Report:** [§9](../../docs/reports/unified-federation.md#9-cross-node-features) (Settings layering)
- **Depends on:** [3001](3001-scoped-store-shim-and-ratchet.md), [3002](3002-lib-backend-client-parameter.md)
- **Parallel with:** [3003](3003-stores-batch-a-leaf-light.md), [3004](3004-project-and-environment-stores.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

Inherited settings are computed from two explicit scopes, not from "is this renderer a realm".

## Current state (verified 2026-11-07)

- `configStore`: 93 LOC, 15/10 imperative sites, 28 direct importers, 57 references, 66 test files. It has no store dependencies.
- `apps/web/src/lib/portal/command-node-config.ts` (222 LOC): `settingsOnCommandNode()` is `workspaceTarget() !== null`. It calls the portal helper `isUnknownBackendCommand` (fixed in [0007](0007-unknown-command-helper.md)).
- `hooks/useAgentModelFavorites.ts` writes favourites with `update_global_config` plus `preserveInheritedSettings`. An upgraded leaf answers an unchanged echo with its current settings (`isGlobalConfigEcho`, counter `workspace-grant.config-echo`; todo 5740 task 2).

## Work

- [ ] Convert `configStore` to a scoped store.
- [ ] `effectiveConfig(scope) = layer(commandScope.config, scope.config)`, with the same layering rules as `command-node-config.ts`.
- [ ] Split saves take both scopes explicitly: the inherited parts go to the command scope, and the machine parts go to the node scope.
- [ ] `useAgentModelFavorites` keeps the echo-compatible request shape for leaves that need it. Check the register row before changing it.

## Tests

- [ ] Layering: a command-node value is inherited, a leaf override wins, and saving each part reaches the right scope's client.
- [ ] `command-node-config` tests ported to explicit scopes.

## Done when

- [ ] No code reads `workspaceTarget()` to decide config layering.
