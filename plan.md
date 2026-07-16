# Persistent Backend-Held Tab State (restore-on-connect)

## Context

The user wants to disconnect a client (Electron desktop or remote web client) and reconnect from a *different* client with the open tabs and their content preserved, as long as the backend isn't reset.

**The architecture already supports most of this.** The standalone Bun backend (`apps/backend`) serves all clients over HTTP invoke + SSE (`apps/backend/src/gateway.ts`); nothing is torn down on client disconnect; multiple/remote clients (Tailscale) are already supported. Terminal scrollback (`sessions.json` + `buffers/<sessionId>.txt`), agent transcripts (bridge servers / tmux in the container), and file contents are all backend-sourced and re-fetchable.

**The one gap**: the tab/pane layout — which tabs are open, splits, ordering, active tab, and the per-tab identifiers (`TabInfo.*Data`) — lives only in browser memory in `paneLayoutStore` (`apps/web/src/stores/paneLayoutStore.ts`, no persist middleware). A new client gets a freshly seeded default layout from `TerminalContainer.tsx` instead of the previous arrangement. Additionally, native-chat tabs never write their bridge `sessionId` back into `TabInfo`, so transcripts can't be re-found cross-client.

**Decisions** (user didn't answer clarifying questions; recommended defaults used):
- **Sync model: restore-on-connect.** Layout saved to backend as the user works; a connecting client loads it. Last-writer-wins between simultaneous clients; no live mirroring (a cheap SSE notification is emitted for future use, no subscriber required).
- **Scope: layout + existing content rehydration.** No persistence of compose drafts or unsaved editor buffers.

## Implementation

### Phase 1 — Backend storage + commands

**Shape** (add to `apps/backend/src/core/models.ts` and `apps/web/src/types/index.ts`):

```ts
export const PANE_LAYOUT_VERSION = 1;
export interface PersistedPaneLayout {
  version: number;
  environmentId: string;
  containerId: string | null;   // container the layout was built against
  activePaneId: string;
  root: unknown;                // opaque PaneNode tree — backend does NOT re-model it
  updatedAt: string;            // stamped by backend
  revision: number;             // monotonic, stamped by backend
}
```

Backend keeps `root` opaque (envelope + size validation only); the frontend validates the tree on restore. Single file `pane-layouts.json` holding `Record<environmentId, PersistedPaneLayout>` — matches `sessions.json`/`kanban.json` patterns and gets atomic writes + backup rotation from `loadJson`/`saveJson` for free.

**`StorageService`** (`apps/backend/src/core/storage.ts`, next to `sessionsFile()` ~line 384):
- `private paneLayoutsFile()` path helper.
- `getPaneLayout(environmentId)`, `savePaneLayout(environmentId, {containerId, activePaneId, root, version})`, `deletePaneLayout(environmentId)`.
- Wrap save/delete in a `enqueuePaneLayoutMutation` promise chain (copy the `featurePlanMutation` pattern ~line 354) — `writeQueue` serializes only the write, not the read-modify-write.
- Size cap: reject `JSON.stringify(root)` > 256 KB (mirrors the 500 KB buffer cap philosophy).
- `savePaneLayout` stamps `updatedAt` + increments `revision` from the previous record.

**Commands** (`apps/backend/src/core/commands.ts`, next to session commands ~line 2486):
- `get_pane_layout { environmentId }` → record or null.
- `save_pane_layout { environmentId, layout }` → validates envelope, saves, then `emit("pane-layout-updated", { environment_id, revision })`.
- `delete_pane_layout { environmentId }`.
- In `delete_environment` (~line 2091, after `removeSessionsByEnvironment`): `await storage.deletePaneLayout(envId).catch(() => undefined)`.

**Frontend wrappers** in `apps/web/src/lib/backend.ts`: `getPaneLayout` / `savePaneLayout` / `deletePaneLayout` via the existing `invoke` pattern.

### Phase 2 — Frontend persistence (writes)

**Hydration guard in `paneLayoutStore`** — add to state:
```ts
hydration: Map<string, "pending" | "done">;
beginHydration(environmentId);                          // → "pending"
finishHydration(environmentId, restored?: EnvironmentPaneState);  // installs restored state if given, → "done"
```
Persistence only writes layouts for environments whose hydration is `"done"` — this prevents the empty/default layout from clobbering a saved one during startup ordering, and skips env states created merely by `setActiveEnvironment` (~line 329).

**New module `apps/web/src/lib/pane-layout-persistence.ts`** — do NOT instrument the 12 mutators; a single vanilla `usePaneLayoutStore.subscribe(...)` catches everything:
- Per-environment 1s debounce; skip if hydration ≠ `"done"`; skip if serialized snapshot equals last-saved (`lastSaved` map — clear the entry on save failure so it retries on the next change).
- `sanitizeForPersist(root)`: deep-clone dropping `initialPrompt` / `initialCommands` from every `TabInfo` (must never re-fire on another client).
- Accept an injectable `save` fn (defaults to `backend.savePaneLayout`) so tests need no `mock.module`.
- `finishHydration` primes `lastSaved` with the restored snapshot so merely connecting never writes (avoids clobber races between two connecting clients).
- Start once at app startup in `App.tsx`, alongside the existing global monitors.
- Deliberate `reset()` (container stopped/changed) persisting the cleared layout is correct — those sessions are dead.

### Phase 3 — Frontend hydration (restore-on-connect)

**New pure module `apps/web/src/lib/pane-layout-restore.ts`** — `reconcilePersistedLayout(saved, ctx) => EnvironmentPaneState | null`:
1. `version !== 1` → null.
2. Container identity: docker env with `saved.containerId !== ctx.containerId` → null (mirrors the reset-on-container-change rule at `TerminalContainer.tsx:1083`); local envs (both null) proceed.
3. Structural validation of `root` (it arrives as `unknown`): leaf/split shape, `children.length === 2`, `depth <= MAX_SPLIT_DEPTH`. Malformed → null (fall back to default seeding).
4. Per-tab sanitation while cloning:
   - Drop unknown `type` values (forward compat) and tabs missing their per-type data object.
   - Strip `initialPrompt`/`initialCommands` (defense in depth) and `hostPort` from `*NativeData` (stale across bridge restarts; cold-start re-resolves it — `ClaudeChatTab.tsx` ~404–448).
   - Convert setup tabs (`isSetupTab`) to plain terminal tabs — scrollback still replays via the persistent session matched by `tabId`.
   - Drop `claude-build` tabs unless `ctx.hasBuildPipeline(pipelineId)` (`buildPipelineStore` is in-memory-only).
   - Dedupe tab ids across the tree.
5. Collapse zero-tab leaves into their sibling (reuse/duplicate `replaceNode`/`findParentSplit` from `paneLayoutStore.ts:54–113`); nothing left → null.
6. Repair pointers: `activeTabId` must exist in its leaf; `activePaneId` must reference an existing leaf.

**`TerminalContainer.tsx` seeding effect** (~lines 729–1079): inside the `currentTabs.length === 0` branch (line 745), after computing `backendSetupRunning` (line 746) and before the setup/attachment/`initialize` logic:
- Skip hydration while `backendSetupRunning` (fresh env — setup flow owns the layout).
- `hydrationStatus === "pending"` → return (restore in flight).
- `hydrationStatus === undefined` → `beginHydration(environmentId)`, async `backend.getPaneLayout` → `reconcilePersistedLayout` → `finishHydration(environmentId, restored ?? undefined)` (catch → `finishHydration(environmentId)`), return.
- `hydrationStatus === "done"` with still-zero tabs → fall through to the existing default seeding, unchanged.
- Add `hydrationStatus`/`beginHydration`/`finishHydration` to the dependency array. When `finishHydration` installs restored state, the effect re-runs with tabs > 0 and skips seeding.
- Optionally clear the env's hydration entry in `reset()` so a container restart re-attempts hydration cleanly.

**Native chat transcript rehydration** (makes chat tabs restore cross-client):
- New `paneLayoutStore` action `updateTabNativeSessionId(tabId, sessionId, environmentId?)` — pattern-copy `clearTabInitialPrompt` (~line 638); patches whichever `*NativeData` exists on the tab. The persistence subscription then saves it.
- `ClaudeChatTab.tsx`: everywhere the session id is established (`tabSessionIdRef.current = ...` at ~lines 375, 558, 579, 1304), also call `updateTabNativeSessionId`. On cold start, fall back to `data.sessionId` from the restored `claudeNativeData` (~line 513: `existingSessionFromRef || existingSessionFromStore?.sessionId || data.sessionId`), and relax the message-refresh guard at ~line 536 to run whenever a session id exists (seeding the store when it had nothing). The existing `SessionNotFoundError → createSession` fallback (~line 551) handles dead sessions and should also write back the replacement id.
- Repeat the same three-line pattern in `CodexChatTab.tsx` and `OpenCodeChatTab.tsx` (verify their init flows individually). This sub-phase is cleanly severable if the first release is layout+terminal-only.
- `claude-tmux` tabs need nothing: tmux state is keyed `(environmentId, tabId)` and tab ids are preserved.

### Stale-tab behavior (mostly existing code, verify during implementation)

| Restored tab | Behavior |
|---|---|
| terminal, session record exists | `PersistentTerminal.tsx` (~line 508) matches by `tabId`, replays buffer into a fresh shell; `hasLaunchedCommand` prevents agent relaunch |
| terminal, session record missing | creation path (~line 583) makes a new persistent session |
| native chat, bridge session gone | `SessionNotFoundError` → new session; tab survives, transcript lost |
| file tab, file gone | re-read fails into the viewer's own error state |
| build tab | dropped at reconcile |

Note: a second client gets a fresh shell with replayed scrollback, not the first client's live PTY — same as today's app-restart behavior.

## Files to modify

- `apps/backend/src/core/storage.ts` — pane-layout load/save/delete + mutation queue
- `apps/backend/src/core/commands.ts` — 3 new commands + `delete_environment` cleanup
- `apps/backend/src/core/models.ts`, `apps/web/src/types/index.ts` — `PersistedPaneLayout`
- `apps/web/src/lib/backend.ts` — invoke wrappers
- `apps/web/src/stores/paneLayoutStore.ts` — hydration map + `updateTabNativeSessionId`
- `apps/web/src/lib/pane-layout-persistence.ts` (new) — debounced subscriber
- `apps/web/src/lib/pane-layout-restore.ts` (new) — `reconcilePersistedLayout`
- `apps/web/src/components/terminal/TerminalContainer.tsx` — hydration attempt in seeding effect
- `apps/web/src/components/claude/ClaudeChatTab.tsx` (+ Codex/OpenCode equivalents) — sessionId writeback/readback
- `apps/web/src/App.tsx` — start persistence subscriber

## Verification

**Unit tests** (bun test; per AGENTS.md keep `mock.module` local — none should be needed):
- `storage` test on an `fs.mkdtemp` data dir: save→get roundtrip, revision increments, per-env isolation, delete, >256KB rejection.
- `pane-layout-restore.test.ts` (pure, no mocks): version/container mismatch → null; unknown tab type dropped; prompt/commands/hostPort stripped; setup-tab conversion; empty-leaf collapse; pointer repair; build-tab drop.
- `pane-layout-persistence.test.ts` (injected save fn): no write before `finishHydration`; debounce coalesces; identical snapshot skipped; failed save retried.
- Typechecks: `bun run --cwd apps/web typecheck`, `--cwd apps/backend typecheck`, `--cwd apps/desktop typecheck`.

**Manual end-to-end**:
1. `bun run dev`; start an environment; split panes (terminal + claude-native), open a file tab, run `ls -la`, send a chat message, reorder tabs, resize the split.
2. Wait >1s; confirm `pane-layouts.json` in the data dir (`~/Library/Application Support/orkestrator-ai/`) has the env entry.
3. Quit the client only (backend keeps running — e.g. standalone backend + web client, or second client via gateway URL).
4. Connect from a different client: verify identical split geometry/sizes/tab order/active tab; terminal shows scrollback in a live shell; chat tab shows prior transcript and can continue; file tab reopens.
5. Stop the container from client 2 → tabs clear; restart → container-id mismatch discards stale layout → fresh default seeding.
6. Delete the environment → entry removed from `pane-layouts.json`.
7. Restart the backend → layout still restores (disk-backed); terminals get fresh shells with scrollback.

## Risks

1. **Seeding-effect ordering** in `TerminalContainer.tsx` is the trickiest area (~20 deps, several early returns). Regression-test the "new env with setup scripts + launch agent" flow carefully.
2. Reconnecting **mid-setup** skips hydration by design; the subsequent default seeding overwrites the saved layout. Acceptable.
3. Two clients mutating the same env simultaneously interleave last-writer-wins. Accepted per the chosen sync model.

## Note on backend lifetime (out of scope, worth knowing)

In the default desktop config the backend is a child process killed on Electron quit (`apps/desktop/electron/backend-lifecycle.ts`). The "disconnect and reconnect from a different client" scenario therefore assumes either the standalone backend running independently (Tailscale/web-client mode, already supported) or the desktop app connected to a remote backend via `connection-manager.ts`. Disk-persisted layout also survives backend restarts regardless.
