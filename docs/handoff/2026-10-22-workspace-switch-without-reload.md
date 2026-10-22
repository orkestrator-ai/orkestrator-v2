# Switching the window's workspace without a reload

Status: Not started. Handoff for a follow-up change.

Opening an environment on another node (a leaf, or the command node while the
window is on a leaf) reloads the whole window. The user wants only the
workspace to the right of the sidebar to change: no reload, and the
environment list stays exactly as it is.

The sidebar order and indentation were fixed on branch
`fix-environment-indentation-fc91d4557412-r1`. That change also makes the list
come back unchanged after the reload (same order, collapse state and scroll
position). The reload itself is what is left. See
[command-nodes.md](../architecture/command-nodes.md#opening-an-environment-on-another-node)
for the current design, which describes the reload as intended.

## How a switch works today

`switchWorkspace(nodeId, intent)` in `apps/web/src/lib/portal/workspace-switch.ts`:

1. Stores the selection intent in `sessionStorage`
   (`orkestrator.workspace-switch-intent`).
2. Desktop: `window.orkestrator.workspaceTarget.set(nodeId)`, handled by
   `setDesktopWorkspaceTarget` (`apps/desktop/electron/window-workspace-target.ts`).
   Browser and iOS: opens a workspace grant on the command node
   (`openLeafWorkspace`) and writes it to `sessionStorage`
   (`workspace-target-storage.ts`).
3. Remembers the sidebar scroll position, then calls `window.location.reload()`.
4. After the reload, `useWorkspaceSwitchSelection` and `takeAddProjectIntent`
   apply the intent once.

The reload is also how every renderer singleton is reset. The design relies on
"one page load = one workspace node".

## What already follows a switch without a reload (desktop)

The main process re-binds the window in place and never reloads it:

- `setDesktopWorkspaceTarget` keeps the command connection on a
  `${scope}:portal` scope and calls
  `ConnectionManager.retargetScopeToWorkspace` (`connection-manager.ts`). Going
  back to the command node uses `restoreScopeFrom`.
- `window.orkestrator.invoke` resolves the scope on every call (`getBackend` in
  `main.ts`), so it reaches the new node at once.
- `orkestrator:event` is matched to the scope's connection per event
  (`emitToConnection` in `main.ts`). The preload has a single IPC listener, so
  renderer `listen` callbacks keep working and start receiving the new node's
  events.
- Request auth for web requests resolves the bearer per request.

The renderer is the problem, not the desktop transport.

## What goes stale without a reload

### Values fixed at page load

Desktop preload (`apps/desktop/electron/preload-api.ts`, from one synchronous
`gateway-sync` snapshot; `contextBridge` freezes exposed values):

- `window.orkestratorDesktopIdentity` (`exposeActiveConnectionGateway`):
  `connectionId`, `backendId` and `legacyOrigin` stay on the old node.
- `window.orkestratorWorkspaceTarget` is exposed only if a target existed at
  load. A command-node window that moves to a leaf has none; a leaf window
  that moves back keeps the old one.
- `window.orkestratorPortal` (`exposePortal`) is exposed only if a target
  existed at load. Without it, `portalInvoke` and `portalListen` fall back to
  the workspace transport. **After an in-place switch from the command node,
  portal calls would go to the leaf.** This is a correctness bug, not just
  stale data, and must be fixed first.
- `window.orkestratorGateway` is exposed only for remote or targeted windows;
  `resolveBaseUrl()` already re-reads the snapshot.

Browser and iOS (`apps/web/src/lib/native/web-gateway.ts`):

- `workspaceTargetGatewayOptions` runs once at module load. It sets
  `window.orkestratorWorkspaceTarget`, `window.orkestratorPortal` and returns
  the grant's base URL and token. It returns `{}` once `window.orkestrator`
  exists, so it cannot be reused as is.
- `createBrowserGatewayApi` captures `baseUrl`, credentials and cross-origin
  mode in its closure. Only the token can rotate (`applyGatewayToken`).
- `configureDirectGatewayTransport` patches global `fetch` and `EventSource`
  for one destination; `clearDirectGatewayTransport` reverts it.
- `installBrowserGatewayApi(..., { replaceExisting: true })` exists but has no
  production caller. Its disposer tears down terminals but does **not** close
  the main event stream (`eventSource` / `streamAbortController`).
- `listen()` in `lib/native/events.ts` binds to whichever `window.orkestrator`
  existed when it subscribed, so subscriptions made before a swap stay on the
  old API object.

Renderer readers of the target:

- `workspaceTarget()` (`lib/portal/portal-transport.ts`) reads
  `window.orkestratorWorkspaceTarget` on each call. Its callers include
  `open-workspace.ts`, `portal-store.ts` (the `includeSelf` flag) and
  `FederationProvider`, whose `useMemo` does not depend on it.
- `App.tsx` reads `window.orkestratorWorkspaceTarget` in `useState`
  initializers and effects.
- `desktop-storage-key.ts` derives persisted-state namespaces from the
  identity and target.

### Renderer state that belongs to the workspace node

- 44 stores in `apps/web/src/stores`. Those holding node data include project,
  environment, session, terminal session, terminal portal, pane layout, Claude
  tmux, native agent projection, native compose, prompt draft, agent activity,
  agent mail, model catalogue, config, kanban, feature plan, GitHub issues, PR
  monitor, build pipeline, looped and multi review, change projection,
  environment diff, worktree snapshot, design, preview service, web
  annotation, artifact live host, rich content view, message part expansion,
  conversation scroll target, file dirty, ACP pending prompt and Claude
  options. About a dozen have a `reset`/`clear` function; most have none.
- Persist keys computed once at module load with `desktopConnectionStorageKey`
  or `windowStorageKey`: `coordinatorPaneLayoutStore`, `filesPanelStore`,
  `nativeNoticeDismissalStore`, `webAnnotationPreferencesStore`, `uiStore`
  (whose `createUIStateStorage` also fixes its project namespace once).
- About 130 module-level `Map`/`Set`/`let` caches in `lib/` and `hooks/`.
  Notable ones are in `hooks/useProjects.ts`, `hooks/useEnvironments.ts`,
  `lib/resource-sync.ts` (`resetResourceSync` exists but is for tests), the
  read coordinator, `lib/chat/artifact-requests.ts`, `lib/changes/subscriptions.ts`
  and the prompt-queue, file-draft and build-pipeline persistence modules.
- Existing connection-change resets: `setReadCoordinatorConnection` (bumps a
  generation and aborts in-flight reads) and `noteRichContentConnection`. Both
  are called only from `App.tsx`, and that path is skipped while a workspace
  target is set.

### Work tied to page lifecycle

- `ConnectedApp` in `App.tsx` starts `startResourceSync`,
  `startStoreResourceSync`, `keepStoredWorkspaceAlive`,
  `startPaneLayoutPersistence` and the build-pipeline migration in mount-once
  effects, plus service hooks (PR monitor, activity monitor, notification
  sound, lifecycle, unread sync).
- Desktop main process: `native-event-stream-connected` is emitted on
  `did-finish-load`. Artifact hosts close and SSH prompts are cancelled on
  `did-navigate`. `rebindWindowPreviews` destroys the window's preview manager
  on a re-bind, which orphans renderer preview tabs. Each needs an explicit
  switch hook instead.

There is no existing in-place switch to build on: `ServerConnectionSwitcher`
has always reloaded, and the old machine-panel realms were removed in #1137.

## Suggested approach

Switch in place by bumping a **workspace generation**, with the reload kept as
the fallback when any step fails.

1. **Live identities.** Desktop: expose functions instead of frozen values
   (`workspaceTarget()`, `desktopIdentity()`), and always expose
   `orkestratorPortal`, pinned to the command node. Browser: make the gateway
   API rebuildable for a new base URL and grant. Disposing the old one closes
   its event stream, and `listen` re-subscribes the existing handlers on the
   new API. Replace direct reads of `window.orkestratorWorkspaceTarget` with
   `workspaceTarget()`.
2. **A reset registry.** Add a `lib/workspace-generation.ts` where each
   node-scoped store and cache registers a reset. Add a unit test that fails
   when a store under `stores/` neither registers nor is listed as
   window-level, so new stores cannot be forgotten. Persisted stores re-key
   with `persist.setOptions({ name })` and `rehydrate()`.
3. **Remount the workspace, not the window.** Key the main pane, title bar
   parts and `ConnectedApp`'s per-node effects and services by the generation.
   Keep the sidebar mounted: its own-machine section re-renders from the reset
   stores, and other machines come from the portal store, which does not
   change.
4. **Sequence.** Fence first (bump the generation and
   `setReadCoordinatorConnection`), then retarget the transport, reset, rehydrate
   and remount. Apply the selection in memory instead of through
   `sessionStorage`, then emit a resync so authoritative listeners reload
   snapshots.
5. **Main-process hooks.** Replace the `did-finish-load` / `did-navigate`
   side effects (event-stream-connected, artifact hosts, SSH prompts,
   previews) with explicit workspace-switch messages.

After this, `rememberSidebarScroll` / `takeSidebarScroll` in
`workspace-switch.ts` and the scroll restore in `HierarchicalSidebar` can go.
Keep `useBoundCollapseSync`: it maps the own machine's collapse state onto
machine-qualified keys, which the sidebar still needs.

## Invariants to keep

From `AGENTS.md`:

- Unmounting the old workspace must not stop its background work.
- Foreground components rehydrate from authoritative snapshots.
- Live events are increments over snapshots.
- A missed event is detectable.
- Closing a tab never deletes a conversation.

Specific to this change:

- No request, event or persisted write for node A may land in node B's state,
  including late responses that arrive after the switch. Fence by generation.
- Portal traffic always reaches the command node.
- The terminal input sequencer and its ambiguous-send fence are per
  connection. Make sure a switch cannot replay or drop input.

## Verification

- Unit: reset-registry coverage, transport retargeting (desktop preload and
  browser gateway), portal pinning after a switch from the command node, and
  stale-response fencing.
- Extend `scripts/qa-leaf-workspace-browser.ts`:
  - Assert that opening a leaf environment causes no navigation
    (`framenavigated` count unchanged).
  - Assert that the sidebar DOM nodes stay connected.
  - Assert that the main pane shows the leaf's environment, and that nothing
    from Desk remains in the stores.
  - Assert that switching back works.
  - Keep its background-work and pending-input checks.
- A sidebar-order QA script from the earlier branch is at
  `output/agent-testing/sidebar-order-qa/qa-sidebar-order.ts`. It is
  git-ignored, so it exists only in that worktree. It checks that order,
  alignment and collapse state survive a switch.
- Desktop: an Electron test that switches nodes in place and checks invoke,
  events, previews and artifact hosts. Also check iOS (its native code
  navigates instead of reloading; see `reloadAfterConnectionChange` in
  `client-platform.ts`).
- Update [command-nodes.md](../architecture/command-nodes.md) ("Switching")
  and `docs/development/command-nodes-handoff.md` when the behaviour changes.
