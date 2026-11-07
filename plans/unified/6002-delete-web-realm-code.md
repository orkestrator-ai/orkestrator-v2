---
id: 6002
title: "Delete the web realm code"
phase: 6
plan: "§5.3, §12 Phase 6.2 and Appendix D"
status: in-progress
depends_on: [6001]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] Delete the web code and tests above (commit 4312188ab; list and corrections in Notes).
- [ ] Delete `packages/protocol/src/realm-boot-timing.ts` and `realm-request.ts` once the desktop no longer imports them. *(Left to [6003](6003-delete-desktop-realm-code.md): `apps/desktop/electron/federation-ipc.ts`, `realm-boot-timing-log.ts` and `tests/federation-ipc.test.ts` still import them; the web client imports neither any more.)*
- [x] Replace `lib/portal/workspaces.test.ts`, `gateway-auth-transport.test.ts` (if the module was deleted in [2003](2003-browser-credentials-and-auth-transport.md)), `uiStore.persistence.test.ts` realm cases and `scripts/qa-leaf-workspace-browser.ts` with in-tree equivalents, or point to [4006](4006-multi-node-qualification.md)'s spec.
- [x] The parity tests keep only the in-tree path.
- [x] Record the gross and net line counts in Notes (the report estimates ~7.4k gross, 1.5-2.5k added back).

## Done when

- [x] No `realm` symbol remains in `apps/web/src` except in survivors renamed out of the realm vocabulary, and the full suite passes. *(No occurrence of `realm` at all in `apps/web/src`, comments included, other than `realM…` identifiers such as `realMonacoReact`. Full web suite and web, protocol and e2e typechecks pass; the aggregate suite is left to review preparation, see Notes.)*

## Notes

- **Approval (2026-11-07).** Deleting the realm code past 6001 without the one-release wait: approved by the user on 2026-11-07, in one combined PR. 6001's two release-gated boxes are marked waived in its item file.
- **Corrections to the deletion list (2026-11-07).** The table missed, and this item also deleted: `components/federation/useRealmBootTiming.ts` (+test), `lib/realm-boot-timing.ts` (+test, its uses in `App.tsx` and `app-startup.ts`), `lib/federation/realm-channel.ts` (+test, 4001's loopback), `components/federation/realm-requests.tsx` (`useRealmRequests`; `nodeName` and the status view survive as `NodeWorkspaceStatus.tsx`), `lib/portal/page-portal.ts` (the realm document's page globals), `stores/inTreeNodesStore.ts` (+test, 6001's rollback), `components/settings/machines/InTreeWorkspaceSection.tsx` (+test) and its row in `MachineSettingsDialog`, `components/federation/FederationProvider.test.tsx` (its one case was a realm document), and `scripts/qa-leaf-workspace-browser.ts` (518 lines; replaced by 4006's `e2e/agent-testing/multi-node-window.spec.ts`). Desktop `realm-boot-timing-log.ts` and `workspace-realm-messages.ts` are 6003's (desktop main imports them). [2003](2003-browser-credentials-and-auth-transport.md) deleted `gateway-auth-transport` with its test, so there was nothing to replace.
- **What 6001, 4001, 4005, 5001-5004 and 4006 left for this item, all removed (2026-11-07).** `useRealmsForRemoteMachines` and `InTreeWorkspaceSection`; the rollback paragraph of the pending release note in `docs/development/releasing.md` (first paragraph kept); the rollback sentences in `node-scopes.md`, `command-nodes.md` and `federation.md`; `realmShellStore`; the realm branches of `useRealmRequests` and `WorkspaceRealmHost` (both gone; the in-tree host is `NodeWorkspaceHost`); `portal-transport.ts`; `page-portal.ts`'s realm read; 5001's per-realm attention path (its box ticked there); `MAX_OPEN_REALMS`; the two `[ui]` shim uses in `WorkspaceRealmHost.tsx` (the file is gone; `scoped-store-shim` was already at 0); 4006's realm-path mode `ORKESTRATOR_AGENT_TEST_IN_TREE=0` (spec, support module and config; evidence now goes to `output/agent-testing/<run>/multi-node/`).
- **Survivors, out of the realm vocabulary.**
  - `lib/federation/window-grouping.ts`: `WindowGrouping`, `windowGroupingFor(sortMode, grouping, phoneLayout)` (was `realmGroupingFor`), `coordinatorDefersToCommandNode(grouping)` (was `realmCoordinatorDefers`; a grouping is always known now, so no `null`), `projectLandingTab`, `projectLandingBoardTab`.
  - `lib/federation/workspace-request.ts`: `WorkspaceRequest` (was `RealmOpenRequest`/`RealmSelectRequest` without `type`, and without the `bugReport` flag, which nothing sets once realms are gone), `WorkspaceBoardTab`, `WorkspaceDialog`, `WORKSPACE_DIALOGS`, `isEnvironmentDialog`, `WorkspaceWorkTarget` (`LocalWorkTarget` aliases it). Web-local types: the web no longer parses requests from URLs or messages, so the protocol's parsers are not needed.
  - `stores/remoteWorkspaceStore.ts`: `active`, `openNodes` (was `realms`), `requests: Record<nodeId, NodeWorkspaceRequest>` (was `RealmRequest`), `open`, `showLocal`, `closeNode` (was `closeRealm`), `startRemoteWorkspaceSelectionSync`, `useRemoteEnvironmentShown`, `useRemoteProjectHomeShown`. Gone: `titleBars`, `panelRequests`, `noteRealmSelection`, `noteRealmTitleBar`, `requestRealmPanel`, `realmPanel`, `MAX_OPEN_REALMS`.
  - `components/federation/NodeWorkspaceHost.tsx` (was `WorkspaceRealmHost`, in-tree branch only), `dialogHydrated`, `NodeDialogHydration`; `components/federation/NodeWorkspaceStatus.tsx` (`NodeWorkspaceStatus`, `nodeName`); `RemoteWorkspaceRegion` is now the region alone (94 lines, from 399); `InTreeWorkspace` mounts the views without a loopback (a document is a generation on the same scope).
  - Test helper `src/test/node-selection.ts`: `selectOnNode(nodeId, selection)`, what the in-tree host and the region do when a shown node's own selection changes, for suites that render neither (replaces `noteRealmSelection` in tests).
- **Decision: keep `remoteWorkspaceStore` as its own store (2026-11-07).** Options: (a) fold the survivors into `windowSelectionStore` as the table suggests; (b) keep the store, renamed out of the realm vocabulary. (a) would move one concern (which nodes the region holds and their pending requests) into the selection module and touch ~60 import sites for no behaviour; (b) keeps the selection in `windowSelectionStore` and the region's held nodes beside it. Chosen (b); the store is 178 lines, from 306 (the table estimated ~90 surviving; the rest is doc comments and the two selection hooks).
- **Decision: the portal global's guard keeps no exception.** `window-orkestrator-portal` now applies to every renderer file (`PAGE_PORTAL_MODULE` removed); no renderer reads `window.orkestratorPortal` or `window.orkestratorWorkspaceTarget`, and both left `vite-env.d.ts`, as did `workspaceViews`, `workspaceRealm` and `orkestratorDesktopIdentity.portal`. The desktop preload still installs the portal and workspace target in realm views, which nothing opens now; 6003 deletes that.
- **Also removed with realm documents (no other reader).** `PortalState.self` and the `includeSelf` summaries read (only a realm document asked for its command node's self summary; `useMachineViews.viewFromSelfSummary`, `ProviderMcpSettings` and `useSettingsModelCatalog` had dead branches on it); `SettingsParent.onConfigChanged` and the scope-less parent (`pagePortalParent`); `useCommandNode().workspaceHere`; `desktop-storage-key`'s browser workspace namespace and `isBrowserLeafRealm`; `rendererErrorRoute`'s realm route (the protocol keeps `"realm"` in `RENDERER_ERROR_ROUTES` so older renderers' reports still parse); `web-gateway.workspaceTargetGatewayOptions`; the App's realm boot alert, zoom and host-tool gates; `GlobalSettingsHost`/`settings-navigation`/`app-shortcuts`/`open-bug-report`/`open-workspace`/`question-desktop-notification`/`node-snapshots` realm branches; `AgentInfoButton` and `SystemUsageIndicator` `remote` (`RealmPanelControl`) props. `ReadCoordinator.setHostHidden` is kept, as [0003](0003-hidden-realm-visibility.md) decided; it has no production caller now.
- **For 6003 (protocol pieces the desktop still needs).** `@orkestrator/protocol/realm-request` (`parseRealmRequest`, `realmRequestToSearch`, `RealmOpenRequest`, imported by `apps/desktop/electron/federation-ipc.ts` and `apps/desktop/tests/federation-ipc.test.ts`) and `@orkestrator/protocol/realm-boot-timing` (`RealmBootTimingMessage`, imported by `realm-boot-timing-log.ts`, which `workspace-realm-messages.ts` uses). Their doc comments still name the deleted web modules. Delete both with the desktop's users, and the two `package.json` exports. `RENDERER_ERROR_ROUTES`' `"realm"` value can go once no supported renderer reports it.
- **iOS (`apps/ios`).** No realm assumption: the app loads the web client in one `WKWebView`, and `RemoteWebView.navigationDisposition` allows subframe navigations, which previews, HTML tabs and design frames still need; the connection bridge is main-frame only. Nothing to change. Recorded rather than adjusted.
- **Line counts (commit 4312188ab, `git show --numstat --no-renames`).** Gross 9,038 lines deleted, 2,187 added, net −6,851. Web source −3,207/+890 (net −2,317); web tests −4,953/+1,148 (net −3,805; the additions are the in-tree replacements `NodeWorkspaceHost.test.tsx`, `RemoteWorkspaceRegion.test.tsx`, `window-grouping.test.ts` and the converted cases); e2e and scripts −767/+72; root tests and guards −61/+46; docs −50/+31. The report estimated ~7.4k gross with 1.5-2.5k added back; the desktop's share (~1.5k) is 6003's, so the web side came out larger than estimated (boot timing, the loopback, the rollback and the realm-document test cases were not in it).
- **Tests replaced (Work box 2).** `lib/portal/workspaces.test.ts`: the realm boot case became "the page boots as its command node's client, whatever its URL names" (no portal global installed), with a pointer to `node-clients.test.ts` and 4006's spec for leaves. `uiStore.persistence.test.ts`: the realm case became per-node UI state under each node's own key, apart from the window's chrome (leaf scopes). `scripts/qa-leaf-workspace-browser.ts`: deleted, 4006's spec covers the same flows in-tree. `RemoteWorkspaceRegion.test.tsx`: rewritten for the region (placement over the anchor, held nodes, selection sync, removed machines). `WorkspaceRealmHost.test.tsx` and `.paths.test.tsx` became `NodeWorkspaceHost.test.tsx` (22 cases: every applicable case of both, on the in-tree path). Realm-document cases in the settings, portal, accounts, MCP, leaf-mode gate, app-shortcuts, attention, notification, title-bar and boot suites were converted to the window (command node plus `invoke_on_node`) where an in-tree equivalent exists, and deleted where they only described a realm document (listed in the commit).
- **Parity (Work box 3).** The unit parity suite that ran on both paths (`WorkspaceRealmHost.paths.test.tsx`) keeps only its in-tree path in `NodeWorkspaceHost.test.tsx`; `InTreeWorkspace.direct.test.tsx` and `.cross-node.test.tsx` lost the loopback observer (nothing crosses a loopback when there is none); 4006's e2e lost its realm mode.
- **Guards.** Baseline updated with `update-baseline.ts --guard window-orkestrator-direct --guard direct-transport-import --guard scoped-store-shim --guard lib-backend-command-default --guard workspace-command-bound-call --guard window-orkestrator-portal`; only falls: `window-orkestrator-direct` `App.tsx` 8→7, `desktop-storage-key.ts` 3→2, and `RemoteWorkspaceRegion.tsx`, `workspace-realm.ts`, `realm-boot-timing.ts` removed. `sleep-before-negative-assertion` was not rescanned (other agents' new findings would have been absorbed): its `RemoteWorkspaceRegion.test.tsx` entry (1) is now stale; the orchestrator's end-of-wave regeneration drops it.
- **Files outside the item's set (minimal).** `components/layout/MobileAppShellLayout.tsx` (the drawer's yield condition loses `request.bugReport`; comment) and its test (`type: "select"` and the `bugReport` assertion), re-read after the bug-fix agent's e46872643; e2e fixtures `SettingsMachineFixture.tsx` (now a command window showing the leaf) and `PipelineFlowFixture.tsx`, `SettingsMachineRouting.spec.ts` (browse enabled on the window's own machine), `KeyboardShortcuts.spec.ts` and its fixture (the realm-frame case).
- **Effect.** Not used: this item deletes code; the survivors are a zustand store, pure functions and React components whose lifetimes are the scopes' (already Effect-backed).
- Aggregate suite left to review preparation. Known failures not caused by this item, seen in the root run: `source-guards.test.ts` (other files' new findings), `dom-absence-scan.test.ts` (other files; this item's `RemoteWorkspaceRegion.test.tsx` uses `expectDomAbsent`), `mise-tasks.test.ts` (`plans/unified/4004`), `test-suite-ownership.test.ts` (two e2e/unit files of other items); `tests/tsconfig.json` has one error in `tests/unit/lib/terminal-paste.test.ts` (another agent's terminal change). The e2e fixture run had one known flake under load (`KeyboardShortcuts.spec.ts` "Meta+I focuses the assigned agent composer", case `docs/tests/flaky-tests/web-ui/1902-assigned-composer-shortcut-startup.md`; 12 of 12 alone).

## Work log

- 2026-11-07 (claude-worker): deleted the web realm code (iframe and native realms, the shell-realm protocol and the in-tree loopback, realm documents, boot timing, the realm title bar and overlay avoidance, `MAX_OPEN_REALMS`, 6001's rollback) and its tests; renamed the survivors out of the realm vocabulary; replaced the realm suites with in-tree equivalents; removed 4006's realm-path mode; updated the guard and docs. Commit 4312188ab (205 files, +2,187 −9,038). Tests: full web suite `bun --cwd=apps/web test --parallel=4` pass (14,149 pass, 0 fail; final rerun after the last test fixes green); web `bun check --all`, `packages/protocol` typecheck, `e2e/tsconfig.json` and `e2e/agent-testing/tsconfig.json` clean; root `bun test ./tests --parallel=4`: 4,310 pass, 5 fail, all pre-existing (Notes); `tests/unit/components/HierarchicalSidebar.test.tsx` 104 pass; `window-orkestrator-portal-guard.test.ts` pass; e2e fixture specs `SettingsMachineRouting`, `KeyboardShortcuts`, `PipelineFlow` (filtered): 75 pass, 1 known flake. fmt and oxlint clean on touched files. Box left open: the protocol modules wait for 6003.
