---
id: 4001
title: "In-tree workspace for a leaf, behind a per-node setting"
phase: 4
plan: "§5.2 and §12 Phase 4.1-4.2"
status: not-started
depends_on: [2013, 3013, 3014]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 4001 · In-tree workspace for a leaf, behind a per-node setting

- **Report:** [§5.2 The React shape](../../docs/reports/unified-federation.md#52-the-react-shape), [§12 Phase 4](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [2013](2013-second-scope-proof.md), [3013](3013-pane-layout-store.md), [3014](3014-scoped-services-and-startup.md)
- **Blocks:** the rest of Phases 4 and 5
- **Size:** M
- **Track:** S (scopes), critical path

## Goal

With a setting on for a node, its workspace renders in the window's own React tree under a `NodeScopeProvider`, with the same code the command node uses. Every other node still uses a realm.

## Current state (verified 2026-11-07)

- The seam: `RemoteWorkspaceRegion.tsx:89-99` picks `kind === "desktop" ? <NativeRealm/> : <FrameRealm/>`, where `kind` comes from `useFederation()` (:61). `NativeRealm` is at :373, `FrameRealm` at :513 and `useRealmRequests` at :163; they are private to that file and used at :404 and :538.
- `WorkspaceRealmHost.tsx` (313 LOC) gates dialogs on readiness inside a realm.
- In `workspace-realm.ts`:
  - `isWorkspaceRealm` (:304), `postToShell` (:513) and `onShellMessage` (:525) read the URL and `window`;
  - `realmGroupingFor` (:86), `realmCoordinatorDefers` (:103) and `projectLandingTab` (:113) survive.

## Work

- [ ] A setting `inTreeNodes: nodeId[]` (default empty), persisted per window and editable in Settings → Machines, with a development override. The setting is a rollback switch, not version skew (`version-compatibility.md`).
- [ ] `<InTreeWorkspace nodeId>`: acquires a node scope (browser `node-clients`, desktop `orkestrator:nodes:open`), wraps `<NodeScopeProvider><NodeErrorBoundary><Workspace/></NodeErrorBoundary></NodeScopeProvider>`, and releases on unmount after the grace period ([4002](4002-hydration-tiers-and-budgets.md)). Unmount must not cancel backend work.
- [ ] `RemoteWorkspaceRegion` renders `InTreeWorkspace` when `inTreeNodes.has(nodeId)`.
- [ ] A realm context replaces URL and `window` reads in `isWorkspaceRealm`, `postToShell` and `onShellMessage`. An in-memory loopback implements `send`/`onMessage`, so `useRealmRequests` sequencing and `WorkspaceRealmHost` dialog gating run unchanged under the provider. [4005](4005-direct-navigation.md) then removes the loopback message by message.
- [ ] `NodeErrorBoundary`: per-node error with retry. A crash in one node's tree does not take down the window shell.
- [ ] The command node's own workspace renders through the same `NodeScopeProvider` path (one workspace implementation).

## Tests

- [ ] Region test: in-tree for a flagged node, realm otherwise; switching between them keeps both nodes' backend work running.
- [ ] The parity suites run on both paths.
- [ ] Error boundary isolation.

## Done when

- [ ] A flagged leaf renders and works in-tree on desktop and browser against a live attached profile (open environment, terminal, agent tab without a billed turn, files, previews).
