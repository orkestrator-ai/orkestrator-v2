---
id: 5002
title: "PR opener, title-bar meters and popovers from the scope"
phase: 5
plan: "§9 and §12 Phase 5.2"
status: done
depends_on: [4001, 3007]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 5002 · PR opener, title-bar meters and popovers from the scope

- **Report:** [§9](../../docs/reports/unified-federation.md#9-cross-node-features), [Appendix C](../../docs/reports/unified-federation.md#appendix-c-the-realm-protocol-and-what-replaces-it)
- **Depends on:** [4001](4001-in-tree-workspace-seam.md), [3007](3007-files-panel-split.md)
- **Blocks:** [6001](6001-in-tree-by-default.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

Opening a PR in the app works for any shown node. Title-bar meters and the agent popover are ordinary components fed by the shown scope.

## Current state (verified 2026-11-07)

- `lib/pull-request-opener.tsx:77`: `if (useRemoteWorkspaceStore.getState().active) return false;` (the function spans :73-83).
- `RealmTitleBar.tsx` (269 LOC) plus the `panel`, `panelDismissed` and `titleBar` messages: popovers drawn by the realm under window triggers, with seq, inset and focus handoff.
- `useMachineSystemUsage(nodeId)` already feeds `MachineCpuReadings`.

## Work

- [x] The PR opener resolves the shown scope and opens in that scope's files panel. Delete the `active` early return for in-tree nodes.
- [x] The title bar uses `useMachineSystemUsage(shownNodeId)` and ordinary popovers whose data comes from the shown scope. Replace `panel`, `panelDismissed` and `titleBar` for in-tree nodes.

## Tests

- [x] PR opener with a leaf shown; meters switch with the shown node; popover focus returns to its trigger on dismissal.

## Done when

- [x] None of the three messages is used for in-tree nodes.

## Notes

- **API (2026-11-07).**
  - `lib/node-scope/shown-scope.ts`: `shownNodeScope(windowScope = getWindowScope()): NodeScope | null`: the scope of the window selection's node (the command scope while nothing is selected), `null` while the window shows a node it has no scope for (a realm's).
  - `lib/pull-request-opener.tsx`: `openPullRequestInApp(ref, view?, scope = shownNodeScope())`: with no scope it returns false (the caller falls back to the browser; a realm opens pull requests in its own panel). The `active` early return was already gone (3006 replaced it with the cleared selection); the default is now the shown scope instead of the command scope, so callers outside a provider (agent mail panel, Kanban task dialog, `openPullRequestUrl`) open in an in-tree leaf's files panel. `ProjectPullRequestsView` reads `currentFilesPanelTargetId(scope)` for its own node (it read the command node's).
  - `components/layout/ShownNodeTitleBar.tsx`: `useShownInTreeNode(nodeId) → { scope: NodeScope | null } | null` (null: no node, or one a realm shows; `scope` null while `InTreeWorkspace` is still opening it), `NodeTitleBarUsage({ scope })`, `NodeTitleBarAgentInfo({ scope, mobile? })`: the ordinary `SystemUsageIndicator` and `AgentInfoButton` inside `WindowScopeProvider > NodeScopeProvider scope` (keyed by node); inert meters (dashes) and trigger while the scope opens. `AppShell` uses them on the desktop and in the phone title bar for an in-tree node; a realm's node keeps `RealmSystemUsageMeters`/`RealmAgentInfoTrigger`, and `useRealmPanelDismiss` only runs for a realm.
  - Popover contents on the scope: `SystemUsageIndicator` reads `useSystemUsage({ scope })` and `useEnvironmentProcessUsage({ scope })` (new `scope` option) of the nearest node scope; `AgentInfoButton` passes its scope to `useSystemUsage`, `useAccountPlanUsage({ scope })` (new) and shows the leaf client's `route` as its connection path (a browser's `LeafNodeClient.route`; the desktop's goes through main and reports none); `AgentInfoAccountSection` reads and switches accounts through `backendForScope(scope)`, names the scope's node (`useSessionMachineName`), and listens on the scope (`useAgentAccountsChanged(platform, onChange, scope?)`: `listenInScope` plus `onReconnectInScope` for a leaf). This closes 4001's deferral (5).
  - `useMachineSystemUsage({ …, scope? })`: a machine with an open leaf scope is read on that scope with the same key and coordinator as the title bar's `useSystemUsage({ scope })`, so the CPU reading and the meters share one read instead of a second relayed `invoke_on_node`. `MachineCpuReadings` passes the window's open leaf scopes.
  - `RealmTitleBarPanels` draws nothing on a loopback (`channel.kind === "loopback"`); the page path is unchanged (`PageRealmTitleBarPanels`). So for an in-tree node nothing posts `titleBar` or `panelDismissed` and nothing writes `panelRequests` (so `useRealmRequests` sends no `panel`).
- **Decision: meters through `useSystemUsage({ scope })`, which `useMachineSystemUsage` joins (2026-11-07).** Options: (a) the title bar calls `useMachineSystemUsage(shownNodeId)` as the item text says, which for a leaf reads through the command node (`invoke_on_node`); (b) the title bar reads the shown scope directly and `useMachineSystemUsage` joins that read when the window has a scope for the node. Chosen (b): the scope is already open and warm, the popover's own meters and the process list need the scope anyway, and one coordinator key per node keeps a single read for the title bar, the popover and the per-machine CPU figure. A node without a scope keeps (a)'s relayed read.
- **Decision: popovers stay where they sit (2026-11-07).** The realm path's inset, seq and focus handoff existed only because the popover was drawn in another document. In the window's tree the popover is the same component the command node uses, positioned under its own trigger, and closing it (Escape, close button, outside press) returns focus to the trigger by the component's own code. No new popover component was needed.
- **Effect.** Not used: these are React components and a pure lookup over `WindowScope`'s signals; the read lifetimes are the read coordinator's and the scope's (already Effect-backed).
- **Visible change (behind the setting).** Rendered from the real components in headless Chromium (harness `output/visual-previews/5002-harness`, `output/agent-testing/5002/shoot.ts`): before (realm path: window triggers from the realm's `titleBar` report, popover drawn by the realm under them) `output/visual-previews/5002-title-bar-before.png`, `5002-title-bar-before-narrow.png`; after (in-tree: ordinary meters and popover on the leaf's scope) `5002-title-bar-after.png`, `5002-title-bar-after-narrow.png`, and the agent popover `5002-agent-popover-after.png`, `5002-agent-popover-after-narrow.png`. They look the same, which is the point.
- **Files outside the item's set touched (minimal):** `components/pull-requests/ProjectPullRequestsView.tsx` (its own node's target id), `hooks/useAgentAccountsChanged.ts`, `components/layout/useAccountPlanUsage.ts`.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): shown-scope PR opener; in-tree title bar from the scope (meters, process popover, agent popover with usage, plan usage, accounts and route on the node); realm title-bar panels off on a loopback; `useMachineSystemUsage` joins an open scope's read. Tests: `ShownNodeTitleBar.test.tsx` 3 (meters read the shown leaf and switch between leaves with no command-node read; dashes while opening; process popover is the node's and focus returns to the meters on Escape and on its close button), `AppShell.test.tsx` +1 (in-tree meters and agent button on the leaf's scope, switching leaves and back), `pull-request-opener.test.tsx` +1 (leaf shown: opens in the leaf's files panel, not the command node's; a realm-only node falls back), `InTreeWorkspace.cross-node.test.tsx` (shared with 5003: no `panel`, `panelDismissed` or `titleBar` crosses an in-tree loopback). Focused web run: 1321 pass, 10 skip, 0 fail across 62 files (`components/layout`, `components/federation`, bug report, pull requests, shortcuts, opener, usage hooks; `--parallel=2`). Web typecheck clean; fmt and oxlint clean on touched files. Commit a76e7684c (built from HEAD with only this item's `AppShell` hunks).
