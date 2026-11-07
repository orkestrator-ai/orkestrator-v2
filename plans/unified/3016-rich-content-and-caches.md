---
id: 3016
title: "Rich content, byte-bounded caches and capability caches per node"
phase: 3
plan: "§7.4 special cases and §12 Phase 3.9"
status: done
depends_on: [2001, 2003]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 3016 · Rich content, byte-bounded caches and capability caches per node

- **Report:** [§7.4](../../docs/reports/unified-federation.md#74-services-and-module-state), [Appendix B](../../docs/reports/unified-federation.md#appendix-b-module-singletons)
- **Depends on:** [2001](2001-node-scope-core.md), [2003](2003-browser-credentials-and-auth-transport.md)
- **Blocks:** [3004](3004-project-and-environment-stores.md), [3008](3008-terminal-portal-and-artifact-hosts.md), [3009](3009-agent-and-transcript-stores.md), [3012](3012-workflow-stores-b.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

Several live nodes neither clear each other's protected content nor multiply cache memory. Capability answers are cached per node.

## Current state (verified 2026-11-07)

- `lib/chat/rich-content-reset.ts:133-152`: identity and connection notes are module singletons, so a second backend identity clears everything.
- Byte-bounded caches, which should become node-qualified keys under window budgets:
  - `lib/chat/artifact-requests.ts`
  - `image-preview-cache.ts`
  - `rich-markdown/media-resolver.ts`
  - `useArtifactPublications.ts`
- Capability caches, each holding one answer per backend:
  - `client-state-capabilities.ts` (75 LOC, module lets at :13-16)
  - `backend/changes.ts:129`
  - `design-client.ts:109`
  - `useNativeAgentSession.ts:129-143`
  - `useTranscriptArtifactCapabilities.ts`

## Work

- [x] Per-node identity and connection tracking in `rich-content-reset`. Clear by node, using the mechanism from [2003](2003-browser-credentials-and-auth-transport.md).
- [x] Caches key by `(nodeId, key)` and reserve from the window `ByteBudget`.
- [x] Capability caches move onto the scope. They are later folded into domain versions in Phase 7.

## Tests

- [x] Two identities live at once: neither clears the other; one window budget is shared; a scope's capability cache is independent.

## Done when

- [x] No module-level capability or identity singleton remains in the listed files.

## Notes

- **API (2026-11-07).**
  - `apps/web/src/lib/node-scope-slots.ts` (new): `defineScopedSlot<T>(name, create)` returns `slot(scope?)`, `scope`'s mutable instance created on first use through `scope.store(def)` (dropped on dispose; `create` may register `scope.onDispose`), `slot()` being the app command scope's. `appCommandScope()`, `isAppCommandScope(scope)`, `scopeInvoker(scope)` (the app command scope keeps `@/lib/native/backend` `invoke`, which 2010 made the command scope's client plus prefetched cache, and is what suites mock; any other scope calls `invokeInScope(scope, …)`), `listenInScope(scope, event, handler)` (same rule over `listen` / `client.listenRaw`), type `ScopeInvoke`.
  - `apps/web/src/lib/chat/rich-byte-cache.ts` (new): `NodeByteCache<V>({ name, budget: "images" | "artifacts" | "transcripts", maxEntries, maxEntryBytes?, budgets? })` with `get/peek/has/set(nodeId, key, value, bytes)/delete/deleteWhere/clearNode/clear/values/size/bytes`. Each entry reserves `(nodeId, "<name>\0<key>")` from the window `ByteBudget` with an `onEvict` that drops it; `set` returns false when the budget refuses (the value is then served uncached). An entry whose reservation vanished without a callback (a disposed scope's `releaseNode`, a replaced window scope in tests) counts as absent and is swept before every write. `richContentNodeId(backendId?)`: the open scope named by the content's authenticated `backendId`, else the command scope.
  - `rich-content-reset.ts`: `noteRichContentConnection(connectionId, scope?: NodeScope)` and `noteRichBackendIdentity(backendId, scope?: NodeScope)` replace 2003's `{ nodeId? }` option; the notes live on the scope (`rich-content-notes` slot), default the app command scope. Command scope (`role === "command"`): a change clears everything, as before (it is the window's own connection). Any other scope: a connection change clears `{ nodeId: scope.nodeId }`; an identity change clears `{ nodeId: previousIdentity }`. `richBackendIdentityOf(scope?)`. `clearProtectedRichContent(reason, { nodeId })` now resolves the node's aliases first (the id plus, for every open scope, its node id and the identity it reported, when either matches) and calls `clearBackend` once per alias, matches scheduler keys and view-state prefixes for every alias. This covers the command scope running under `provisional:command-node` while its content carries the identity from capabilities. `resetRichContentResetTracking()` forgets the notes of every open scope.
  - Byte caches, keyed by `(nodeId, key)` and reserving from the window budget: `image-preview-cache.ts` (`images`; every read/write/mark function gained a trailing `nodeId = richContentNodeId()`; `clearImagePreviewCacheForNode`, `imagePreviewCacheStats`; count bound 32 and 8 MiB entry cap kept, the old 24 MiB character total replaced by the 32 MiB `images` budget), `media-resolver.ts` (in-flight reads keyed by node, each with a `current` flag a clear turns off; the `media` protected cache now has `clearBackend`), `artifact-requests.ts` settled reads (`artifacts`; node from the key's `backendId`; `clearArtifactRequestsForBackend` also matches the node a read is accounted to), `useArtifactPublications.ts` ledgers (`artifacts`, bytes estimated as the ledger's JSON length; the epoch carry re-reserves kept ledgers).
  - Per-node clears for the two caches 2003 left whole: `AgentChatFind` registers `clearBackend` and clears its index only when its transcript's `backendId` is that node (or unknown).
  - Capability caches, now per scope through slots, every function taking an optional trailing scope (default the command scope): `clientStateCapabilities(scope?)`, `resetClientStateCapabilitiesForTests(value?, scope?)` (each scope listens for its own stream's reconnect, stopped on dispose); `getChangeTrackingCapabilities(scope = command)` (a default parameter, so `backend.test.ts`'s arity-driven wrapper sweep still calls it with no arguments), `resetChangeTrackingCapabilitiesForTests(scope?)`; `getCapabilities(backend?, scope?)`, `resetCapabilities(scope?)`, `designCommand(command, args, call = invoke)`; new `apps/web/src/lib/native-agent-sync-capabilities.ts` (`nativeAgentSyncSupported`, `nativeAgentProgressiveSupported`, `nativeObservationEventsSupported`, `nativeTranscriptPatchesSupported`, `nativeLiveUpdateSupported`, `disableNativeLiveUpdate`, `invalidateNativeAgentSyncCapability`, all `(scope?)`) holding what was module state in `useNativeAgentSession.ts:129-143`; `useTranscriptArtifactCapabilities.ts` is a per-scope `TranscriptCapabilities` (snapshot, retry timer, generation, listeners) with `readTranscriptArtifactCapabilities(scope?)`, `richMarkdownEnabled(scope?)`, `resetTranscriptArtifactCapabilities(scope?)`, `refreshTranscriptArtifactCapabilities(scope?)`; the hook reads the nearest scope through `useScopesWithCommandFallback` and notes its identity on that scope. `lib/backend` reads used by these (`getClientStateCapabilities`, `getNativeAgentSyncCapabilities`, `getTranscriptArtifactCapabilities`) take an optional `call = invoke`.
  - Callers: `App.tsx` notes the connection list on `getWindowScope().commandScope()` explicitly; `useTranscriptArtifactCapabilities` notes the identity on the scope it read.
- **Decision: where per-node state lives (2026-11-07).** Options: (a) a module `WeakMap<NodeScope, State>` per module; (b) a scoped Zustand store holding the state object (`scope.store(def)`); (c) a new `NodeScope` API for plain slots. (a) keeps a module-level structure and outlives dispose until GC; (c) edits `node-scope.ts`, which 2010 is editing. Chosen (b) behind `defineScopedSlot`: it is 2001's sanctioned per-scope cache, refuses a disposed scope, and drops the slot on dispose. The state is mutated in place (no `setState`), since nothing renders from these slots directly.
- **Decision: registries of open slots (2026-11-07).** Two modules keep a module `Set` of the open scopes' slots: `rich-content-reset.ts` (`openNotes`, to resolve aliases and to reset in tests) and `useTranscriptArtifactCapabilities.ts` (`openCapabilities`, so the one registered protected cache reaches every scope's answer and the registered-cache names stay stable). Each entry is removed by its scope's `onDispose`. They hold no answer or identity of their own, so "no module-level capability or identity singleton" holds: the answers and identities are per scope.
- **Decision: which node a cached item is accounted to (2026-11-07).** Options: the scope that served the read, or the node the content names. Every renderer read still goes through the command node's `invoke` until 3008/3009 scope them, so serving scope alone would put everything on the command node. Chosen: `richContentNodeId(backendId)`, the open scope the content's authenticated `backendId` names, else the command scope; media (no `backendId`) is the command scope's. Per-node clears match both the node an entry is accounted to and the `backendId` in its key, and the alias resolution above joins the two ids of one node.
- **Decision: what stays window-wide or content-keyed (2026-11-07).** The byte caches themselves stay one window-wide instance each (invariant 11: one shared bound, never per-node copies); only their keys and reservations name the node. `markdown-search` stays keyed by the Markdown text: a projection is a pure function of the text, equal on every node, and keying it by node would need a node through the ~8 transcript callers of `getNativeMessageSearchText`. A node clear still clears it whole, which costs a re-parse, never another node's data. The artifact find bodies in `artifact-requests.ts` stay keyed by publication id (server-minted, each entry carries its conversation scope and is cleared by `backendId`); the item does not list them.
- **Effect (2026-11-07): not used.** The window `ByteBudget` from 2001 is already the shared byte bound, with the eviction policy (other nodes first, never the shown node) the report asks for. An Effect `Cache` per cache would add a second bound and a second LRU that knows nothing of other nodes' entries, and these caches are read synchronously during render, which an Effect `Cache` lookup (an effect) does not fit. The capability slots are synchronous state on 2001's Effect-backed scope lifetime, and their cleanup uses `scope.onDispose`, so Effect still runs their disposal underneath.
- **Behaviour changes (2026-11-07).** (1) The image preview total is the window `images` budget (32 MiB placeholder) instead of 24 Mi characters, and it is shared with other nodes' previews. (2) Artifact reads and ledgers share the 16 MiB `artifacts` budget (before, reads alone had 16 MiB and ledgers only a count bound). (3) A test that replaces the app window scope (`resetWindowScopeForTests`) now also resets every capability cache and identity note, since they live on the command scope. (4) `nativeObservationEventsSupported` is no longer exported from `useNativeAgentSession` (nothing imported it); it lives in `native-agent-sync-capabilities.ts`.
- **Outside the file set (minimal).** `lib/backend/client-state.ts`, `workflows.ts`, `transcript-artifacts.ts` (an optional `call = invoke` on one read each) and `lib/backend/changes.ts` (the change-tracking capability cache, listed by the item). Another agent's in-progress unknown-command edits (`incompatibility(...)`) in `design-client.ts`, `useNativeAgentSession.ts` and the new `native-agent-sync-capabilities.ts` were left out of this commit; they stay in the working tree for that agent.
- **For the report.** §7.4's special case for `rich-content-reset.ts` can say identities and connections are noted per node scope and that a command-scope note still clears the window. Appendix B's capability-cache row can say "per scope (slots)", and the byte-cache row "window budget, node-qualified keys" is now true. The report has no mention of the provisional-id alias problem that `nodeAliases` solves; it disappears once 2011 proves the command node's id on a hosted page.
- **Aggregate suite** left to review preparation.

## Work log

- 2026-11-07 (claude-worker): per-scope identity and connection notes with alias-aware node clears in `rich-content-reset`; `NodeByteCache` over the window `ByteBudget` for image previews, media reads, artifact reads and publication ledgers; `AgentChatFind` per-node clear; capability caches (client-state, change tracking, design, native-agent sync, transcript artifact capabilities) moved onto node scopes through `defineScopedSlot`; `App.tsx` notes the connection on the command scope. Tests: new `rich-byte-cache.test.ts` (7) and `rich-content-scopes.test.tsx` (4: two live identities, shared budget with shown-node protection, dispose releasing a node, per-scope capability caches), rewritten per-node cases in `rich-content-reset.test.tsx` (+2), image budget case in `image-preview-cache.test.ts`. Focused runs: `src/lib src/hooks src/stores` 5,068 tests, 1 failure (`lib/portal/portal-layout.test.ts`, another agent's in-progress unknown-command change in `lib/portal`, not touched here); `src/lib/backend.test.ts` plus `components/{chat,design,native-agent,projects,changes,kanban,build-pipeline,review,environments}`, `FileViewerTab`, `App.test.tsx` pass. `apps/web` typecheck clean; fmt and oxlint clean on touched files. `tests/unit/source-guards.test.ts` fails only on other files' baseline findings (none in this item's files).
