---
id: 3017
title: "Window stores with node-qualified references"
phase: 3
plan: "§7.1 class (b) and Appendix A"
status: done
depends_on: [2001]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 3017 · Window stores with node-qualified references

- **Report:** [§7.1](../../docs/reports/unified-federation.md#71-inventory), [Appendix A](../../docs/reports/unified-federation.md#appendix-a-store-classification)
- **Depends on:** [2001](2001-node-scope-core.md)
- **Blocks:** [3006](3006-ui-store-split.md), [5003](5003-settings-bug-report-shortcuts-dialogs.md)
- **Size:** S–M
- **Track:** S (scopes)

## Goal

Window-level stores that point at a project, environment, conversation or message say which node it is on.

## Stores (verified 2026-11-07)

- `appDialogStore` (35 LOC, 4 sites)
- `mergePrRequestStore` (34, 5)
- `activeCoordinatorConversationStore` (86, 2; imports a type from `uiStore`)
- `conversationScrollTargetStore` (167, 2)
- `messagePartExpansionStore` (123, 0)
- `flowGraphViewStore` (104, 4)
- `useHostPathPickerStore` (`lib/host-path-picker.ts`, a `create()` store outside `stores/`; the request must carry a node)
- `bugReportStore` (26, 7/3): stays window-level, but the report runs against a chosen scope ([5003](5003-settings-bug-report-shortcuts-dialogs.md)).

## Work

- [x] Add `nodeId` to every reference these stores hold. Producers pass the scope's node, and readers resolve the scope before acting.
- [x] The host path picker runs its request on the requesting node's client.

## Tests

- [x] A dialog opened for node B acts on B; a scroll target for node A is ignored while B is shown.

## Done when

- [x] Every reference in these stores is node-qualified.

## Notes

- **What each store holds now (2026-11-07).**
  - `appDialogStore`: `AppDialogRequest = { nodeId } & (…)`. `AppDialogHost` resolves `windowScope.get(request.nodeId)` (re-reading on `nodeScopes`), renders the dialog inside `WindowScopeProvider` + `NodeScopeProvider scope={…}` keyed by node, and drops (closes) a request whose node has no open scope, including when the scope closes while the dialog is shown. Producers: `EnvironmentItem`, `SidebarBottomBar`, `CoordinatorPanel` (their scope's node); `open-workspace.openDialog` ("this window's own node") uses `getWindowScope().commandScope().nodeId`.
  - `mergePrRequestStore`: `requestMergePr(nodeId, environmentId)`; the action bar admits only a request for its own scope's node.
  - `activeCoordinatorConversationStore`: the conversation carries `nodeId`; `clear(nodeId, projectId, tabId?)`; `coordinatorConversationTab(conversation, { nodeId, projectId }, boardTab)`. `AppShell` passes its scope's node; `useNotificationSoundService` passes the window's command node, because wake events arrive on the window's own stream.
  - `conversationScrollTargetStore`: requests are keyed by `ConversationScrollTargetRef { nodeId, environmentId, tabId }` (`request(ref, target)`, `peek(ref)`, `clear(ref, nonce?)`, `conversationScrollTargetKey(ref)`). `useConversationScrollTarget` and the native tab read only their scope's node; `openConversationAtMessage(ref, target)` parks for the node that asked (`RequestCard` passes its scope's).
  - `messagePartExpansionStore`: keys are `messagePartExpansionKey(nodeId, key)`; `useMessagePartExpansion` qualifies with its scope's node.
  - `flowGraphViewStore`: keys are `flowGraphViewKey(nodeId, viewKey)`; `useFlowViewport`, `FlowGraph`, `PipelineFlowView` and `GraphRunTab` qualify with their scope's node. The store API still takes strings; the qualification is enforced at the four call sites, not by a branded type (a brand would have meant rewriting every opaque-key store test for no behavioural gain).
  - `useHostPathPickerStore`: `HostPathPickerOptions.nodeId` is required. Components call `usePickHostPath()` (binds their scope's node). `HostPathPickerDialog` resolves `windowScope.get(request.nodeId)?.client` and lists and creates folders through it (`listHostDirectoryOn`, `createHostDirectoryOn` in `lib/host-path-picker.ts`); a request for a node without an open scope is cancelled (resolves null) rather than browsed on another machine.
  - `bugReportStore`: unchanged; it stays window-level and [5003](5003-settings-bug-report-shortcuts-dialogs.md) chooses its scope.
- **Decision: a lenient scope hook.** Options: (a) `useNodeScope()` in producers and readers; (b) a non-throwing variant. (a) throws outside a provider in tests and dev, and these producers and readers render in some 240 test files (every transcript part, the sidebar rows, the action bar, settings) that mount without one; converting them all is the store items' work. Chosen: (b), one additive export in `lib/node-scope/providers.tsx` (outside this item's file set, reported): `useScopesWithCommandFallback(): { windowScope, scope }`, the nearest scopes or the app's window scope and its command scope. That is exactly the production fallback 2001 already defines, so behaviour is unchanged; the strict hooks stay the default for new code.
- **Decision: the picker's fallback.** The brief allowed falling back to the command scope's client. The fallback happens where it is safe, in the producer (outside a provider the request names the command node); the dialog itself never substitutes another node's client for a named node, since that would browse the wrong machine.
- **Behaviour neutrality.** Today every scope is the command scope (`provisional:command-node`), whose client wraps `window.orkestrator`, so every reference names it and every reader resolves it. One difference: the picker's two commands now go through the command client (`window.orkestrator.invoke`) instead of `lib/native/backend.invoke`, so they skip the prefetched-response cache; neither command is ever prefetched.
- **Effect.** Not used: these are synchronous Zustand references and React lookups; scope lifetimes (already Effect-backed in 2001) are only read.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): node ids on every reference in the seven stores, producers pass their scope's node, readers resolve the scope (`AppDialogHost` renders inside the request's node scope and drops unresolvable requests; the action bar, coordinator tab, scroll-target readers, expansion and flow-view keys match their scope's node), and the host path picker runs on the requesting node's client. Added `useScopesWithCommandFallback` to `lib/node-scope/providers.tsx`. New tests: dialog for node B acts on B and unresolvable or closed-scope requests drop (`AppDialogHost.test.tsx`), a scroll target for node A is ignored while B is shown (`useConversationScrollTarget.test.tsx`, store test), the picker browses the requesting node and cancels for an unopened one (`HostPathPickerDialog.test.tsx`, now on `renderInNodeScope` instead of a `native/backend` module mock), merge PR for another node is ignored (`ActionBar.test.tsx`), coordinator conversation, expansion and flow-view node isolation. Existing tests updated for the new signatures.

