---
id: 6002
title: "Delete the web realm code"
phase: 6
plan: "§5.3, §12 Phase 6.2 and Appendix D"
status: not-started
depends_on: [6001]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 6002 · Delete the web realm code

- **Report:** [§5.3 What disappears](../../docs/reports/unified-federation.md#53-what-disappears), [Appendix D](../../docs/reports/unified-federation.md#appendix-d-what-gets-deleted)
- **Depends on:** [6001](6001-in-tree-by-default.md), after one release
- **Parallel with:** [6003](6003-delete-desktop-realm-code.md)
- **Size:** M
- **Track:** S (scopes)

## Files (LOC verified 2026-11-07)

Delete or shrink:

| File | LOC | Test LOC | Action |
|---|---|---|---|
| `components/federation/RemoteWorkspaceRegion.tsx` | 632 | 1,237 | replace with ~80 lines |
| `WorkspaceRealmHost.tsx` | 313 | 695 | delete |
| `RealmTitleBar.tsx` | 269 | 300 | delete |
| `useOverlayOverRegion.ts` | 71 | — | delete |
| `stores/realmShellStore.ts` | 14 | — | delete |
| `lib/federation/workspace-realm.ts` | 544 | 309 | keep `realmGroupingFor`, `realmCoordinatorDefers`, `projectLandingTab` (~60 lines); move them to a non-realm module |
| `stores/remoteWorkspaceStore.ts` | 289 | — | ~90 lines survive in the window selection store from [3006](3006-ui-store-split.md); `MAX_OPEN_REALMS` goes |
| `lib/portal/workspace-target-storage.ts` | 72 | — | delete |
| `lib/portal/portal-transport.ts` | 56 | 106 | delete |
| `components/federation/useRealmBootTiming.ts` | 101 | 184 | delete (**not in the report's list**) |
| `lib/realm-boot-timing.ts` | 69 | 80 | delete (**not in the report's list**); used by `App.tsx`, `app-startup.ts`, `vite-env.d.ts` |
| `packages/protocol/src/realm-boot-timing.ts` | — | — | delete once desktop no longer imports it |
| `realm-request.ts` from [0001](0001-realm-request-drift.md) | — | — | delete |

Remove the realm branches in:

- `AppShell.tsx` (its test has 1,035 lines)
- `App.tsx`
- `GlobalSettingsHost.tsx`
- `app-shortcuts.ts` (test 289)
- `settings-navigation.ts`
- `open-bug-report.ts`
- `open-workspace.ts`
- `renderer-error-ring.ts:151`
- `web-gateway.ts:1709-1743` (the realm grant and the `window.orkestratorPortal` install)
- `RealmPanelControl` props
- `vite-env.d.ts` realm types

## Work

- [ ] Delete the code and tests above.
- [ ] Replace `lib/portal/workspaces.test.ts`, `gateway-auth-transport.test.ts` (if the module was deleted in [2003](2003-browser-credentials-and-auth-transport.md)), `uiStore.persistence.test.ts` realm cases and `scripts/qa-leaf-workspace-browser.ts` with in-tree equivalents, or point to [4006](4006-multi-node-qualification.md)'s spec.
- [ ] The parity tests keep only the in-tree path.
- [ ] Record the gross and net line counts in Notes (the report estimates ~7.4k gross, 1.5-2.5k added back).

## Done when

- [ ] No `realm` symbol remains in `apps/web/src` except in survivors renamed out of the realm vocabulary, and the full suite passes.
