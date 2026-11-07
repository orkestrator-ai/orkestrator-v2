---
id: 6003
title: "Delete the desktop realm code and realm partitions"
phase: 6
plan: "§12 Phase 6.2-6.3, §13.7 and Appendix D"
status: not-started
depends_on: [6001]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 6003 · Delete the desktop realm code and realm partitions

- **Report:** [Appendix D](../../docs/reports/unified-federation.md#appendix-d-what-gets-deleted), [§13.7](../../docs/reports/unified-federation.md#137-desktop-realm-partition-data)
- **Decision:** 13.7 A (abandon realm partition data, then delete the partitions after one release)
- **Depends on:** [6001](6001-in-tree-by-default.md), after one release
- **Parallel with:** [6002](6002-delete-web-realm-code.md)
- **Size:** M
- **Track:** S (scopes)

## Files (verified 2026-11-07)

Delete:

| File | LOC | Test LOC |
|---|---|---|
| `workspace-views.ts` (`RealmLayout`, `realmChildViewClass`, `DEFAULT_MAX_VIEWS`) | 447 | 460 |
| `realm-contexts.ts` | 76 | 155 |
| `realm-boot-timing-log.ts` (**not in the report's list**) | 35 | 48 |
| `workspace-realm-messages.ts` (**not in the report's list**) | 31 | 45 |

Shrink:

- `federation-ipc.ts`: drop the `workspace-views:*` handlers (:320-345), `workspace-realm:post` (:346-348), `portal:invoke` (:349-352), `realmSearch`, and the realm relayed-listen channel.
- `preload-api.ts`: drop `createPortalApi`, `exposePortal`, `createWorkspaceViewsApi` and `createWorkspaceRealmApi` (:385-477, :672-675).
- `preload.ts`: drop `exposePortal`.
- `main.ts`: drop the realm registration, `bindScope`, `closeWindowRealms`, the `portalInvoke` dependency, and `realmChildViewClass` uses.
- `desktop-window-contexts.ts`: drop the realm and portal channels.
- `window-workspace-target.ts`: keep only what `node-scopes.ts` reuses.
- `remote-gateway-request-auth.ts`: drop `createRealmRequestAuthInstaller`.
- `desktop-window-lifecycle.ts`: drop `rendererPartitionForRealm` (:74-76).

## Work

- [ ] Delete the code. Adjust the tests:

| Test file | Lines |
|---|---|
| `desktop-window-contexts.test.ts` | 700 |
| `federation-ipc.test.ts` | 284 |
| `window-workspace-target.test.ts` | 310 |
| `preload-api.test.ts` | 783 |
| `connection-manager-federation.test.ts` | 1,344 |
| `remote-gateway-request-auth.test.ts` | 670 |

  Also adjust `keyboard-shortcuts-routing.test.ts`, `preview-connection-backend.test.ts` and `desktop-window-lifecycle.test.ts`.
- [ ] Adjust `e2e/agent-testing/relayed-events-electron.spec.ts` and `renderer-permissions-electron.spec.ts`, and delete `workspace-realm-electron.spec.ts` (replaced in [4006](4006-multi-node-qualification.md)).
- [ ] Partitions: one release after this deletion ships, remove `persist:orkestrator-realm-*` partition directories on startup. Delete only names matching that exact pattern, under the app's own `userData`.
- [ ] `mise run test:agent:electron` passes.

## Done when

- [ ] No realm IPC, preload API or view manager remains, and partition cleanup is scheduled or done.
