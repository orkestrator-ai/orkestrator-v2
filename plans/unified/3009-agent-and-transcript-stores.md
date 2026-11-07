---
id: 3009
title: "Convert the agent and transcript stores, keeping the history budget window-wide"
phase: 3
plan: "§12 Phase 3.4 and §7.4 Byte budgets"
status: done
depends_on: [3004, 3016]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 3009 · Convert the agent and transcript stores, keeping the history budget window-wide

- **Report:** [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan), [§7.4 Byte budgets](../../docs/reports/unified-federation.md#74-services-and-module-state)
- **Depends on:** [3004](3004-project-and-environment-stores.md), [3016](3016-rich-content-and-caches.md)
- **Blocks:** [3010](3010-sessions-terminals-tmux-mail.md), [3013](3013-pane-layout-store.md)
- **Size:** L
- **Track:** S (scopes)

## Goal

Native agent projections, compose state and prompt drafts are per node. The transcript history byte budget is shared by every node, so per-node instances do not multiply memory (invariant 11).

## Current state (verified 2026-11-07)

| Store | LOC | Imperative sites | Notes |
|---|---|---|---|
| `nativeAgentProjectionStore` | 423 | 18/17 | 33 test files; `historyBytesTotal` at :93-94 is the process-wide budget |
| `nativeComposeStore` | 517 | 52/18 | 13 of the sites are calls on itself |
| `promptDraftStore` | 176 | 9/7 | `claudeTmuxStore` calls it 5 times |

Heavy modules:

- `AgentNativeTab.controller.tsx` (16 sites)
- `AgentNativeTab.tsx` (12)
- `useNativeAgentSession.ts` (12; module-level `syncCapability*` lets at about :129-143)
- `compose-draft-persistence.ts` (207 LOC, 2 singletons)
- `native-session-shared-reads.ts`, `native-observation-events.ts`, `agent-handoff.ts`

## Work

- [x] Convert the three stores. Replace `historyBytesTotal` with reservations on the window `ByteBudget`, using node-qualified keys and the existing eviction order.
- [x] Make the capability lets in `useNativeAgentSession.ts` per scope (folded into domain versions in [7001](7001-domain-native-sessions.md)).
- [x] Turn the module singletons above into scoped services or scope state.
- [x] Convert `AgentNativeTab*` imperative sites (the scope is always known inside a tab).

## Tests

- [x] Two nodes' transcripts share one budget: filling it on node B evicts B's or A's least-recently-shown history, never the shown session.
- [x] Draft persistence is per node.

## Done when

- [x] All three stores are converted, the agent tab works under the command scope, and the budget test passes. (Aggregate suite left to review preparation.)

## Notes

- **API (2026-11-07).**
  - `stores/nativeAgentProjectionStore.ts`: `nativeAgentProjectionStore = defineScopedStore<NativeAgentProjectionState>("native-agent-projection", …)`, `useNativeAgentProjectionStore = scopedStoreHook(…)`, `NativeAgentProjectionState` exported. `historyBytesTotal` is gone from the state. Every sync-cache entry with `historyBytes > 0` holds a reservation `(scope.nodeId, "native-agent-history\0<sessionKey>")` in the window's `transcripts` budget; the store keeps them in step with `syncCaches` through a `subscribe` on its own instance inside the creator (any writer, a test's `setState` included, keeps the budget exact). A budget eviction or a refused reservation runs `dropHistory(sessionKey)`: the entry goes, the projection falls back to its live tail, `historyEvictions` counts up (what the mounted hook already watches). `setProjection` touches the session's reservation, so recency is "last shown". Helpers, each with an optional trailing `scope` (the app command scope when omitted): `evictNativeAgentHistoryCaches(except, required, maximum, scope?)` (now `ByteBudget.evictUntil`), `nativeAgentHistoryBytesExcept(sessionKey, scope?)` (window-wide: every node's retained history but this session's), new `nativeAgentHistoryBudgetBytes(scope?)` (the window total, which replaces the hook's `CLIENT_HISTORY_TOTAL_MAX_BYTES`), `recomputeNativeAgentProjectionTotals(state?)`.
  - `lib/node-scope/byte-budget.ts` (2001's file, additive): `ByteBudget.evictUntil(nodeId, key, targetBytes)`, best-effort eviction by the existing policy (other nodes' LRU, then the caller's own, never `key` or the shown node), for a reader that frees room before sizing a page; `chooseVictims` now shares `evictionOrder` with it. `DEFAULT_WINDOW_BYTE_BUDGETS.transcripts` is 32 MiB (was a 64 MiB placeholder nothing used), the history bound the renderer already had.
  - `stores/nativeComposeStore.ts`: `nativeComposeStore = defineScopedStore<NativeComposeState>("native-compose", …)`, `useNativeComposeStore = scopedStoreHook(…)`. The persistence adapters are per store instance: `nativeComposePersistence(store)` and `unassignedNativeComposePersistence(store)` (one adapter per instance, so the persistence hook's effect is stable), type `NativeComposePersistenceStore`. The old `nativeComposePersistenceStore` / `unassignedNativeComposePersistenceStore` consts remain, `@deprecated`, resolving the app command scope per call (tests use them).
  - `stores/promptDraftStore.ts`: `promptDraftStore = defineScopedStore<PromptDraftState>("prompt-draft", …)`, `usePromptDraftStore = scopedStoreHook(…)`; `usePromptDraftField` writes through `useScopedStoreApi(promptDraftStore)`.
  - All three defs are in the `@/stores` barrel beside their hooks and in `SHIMMED_STORES`.
  - Companion modules, each export with an optional trailing `scope` (3003's convention): `lib/compose-draft-persistence.ts` (its write chains and revision cursors are one `compose-draft-writes` slot; commands through `backendApiForScope(scope, createWorkflowsApi, backend)`); `lib/agent-handoff.ts` (`agent-handoffs` slot: snapshots, reads in flight, epochs, generation; commands through `createAgentHandoffsApi`); `lib/native-session-shared-reads.ts` (`native-session-views` slot); `lib/native-observation-events.ts` (`native-observation-events` slot: one listener per node, over `listenInScope` for a non-command scope, disposed with the scope). `hooks/useNativeComposeDraftPersistence(…, fallbackNamespace?, scope?)`, `hooks/useAgentHandoff` (reads its nearest scope). `addDesignImagesToDraft(key, images, drafts?)`.
  - `hooks/useNativeAgentSession.ts`: the hook reads its node with `useShimNodeScope("native-agent-projection")` and passes it to the projection store, every capability call (`native-agent-sync-capabilities.ts`, 3016's per-scope slot), `readLiveUpdate`, the shared read registration and round, the observation subscription, `onResourceChanged`/`onResourceResync`, and `useCoordinatedRead` (`readCoordinatorFor(scope)`).
- **Decision: how the history budget becomes window-wide (2026-11-07).** Options: (a) keep `historyBytesTotal` per instance and add a window sum; (b) reserve every entry's history from the window `transcripts` budget, which owns the cross-node eviction order (chosen); (c) a module registry of every scope's store. (a) still multiplies the bound by the node count; (c) is module state again. With (b) the old in-store eviction loop is the budget's policy: other nodes' least recently shown sessions, then this node's, never the session being written, never the shown node once 4002 sets it. The reconciliation runs in a store listener rather than inside `set`, because an eviction's `onEvict` writes a store (possibly the same one), and a write inside a running updater would be overwritten by it.
- **Decision: which scope the call sites use (2026-11-07).** Components and hooks use `useShimNodeScope` / `useScopedStoreApi` (3004's choice: their suites, `AgentNativeTab.test.tsx` among them, still render without a provider, and the fallback is noted as a shim use). `AgentNativeTab.tsx` reuses its existing `useShimNodeScope("environment")` scope for the compose store and the config read (the 3005 leftover). `AgentInfoButton` uses its `useScopesWithCommandFallback` scope.
- **Shim counts (`scoped-store-shim`, 2026-11-07).** Before (the plan's count of imperative sites): `native-agent-projection` 18, `native-compose` 52, `prompt-draft` 9. Now: **`native-agent-projection`: 0; `native-compose`: 6 in 4 files; `prompt-draft`: 5 in 1 file.** `config` lost its `AgentNativeTab.tsx` entry. Remaining, all plain code with no scope yet or another item's open file: `stores/paneLayoutStore.ts` (compose 2; 3013), `stores/claudeTmuxStore.ts` (prompt-draft 5; 3010), `components/terminal/TerminalContainer.helpers.ts` (compose 2, `seedDeferredNativePlatform`, called from `TerminalContainer.view.tsx`, which another agent had open), `lib/tab-initial-prompt.ts` (compose 1, plain code), `components/projects/CoordinatorPanel.tsx` (compose 1, another agent had it open). `lib-backend-command-default`: the new slot modules have no command-bound use.
- **Deviation: the display caches stay per instance (2026-11-07).** The projection display LRU (128 sessions, 32 MiB of live tails) and the progressive cache (128 entries, 16 MiB) are still bounded per node instance. Their history portion is the retained pages, which the shared budget bounds (the materialized messages share those objects); the live tails are bounded by the message window. 4002 should decide whether warm nodes keep them or reserve them too.
- **Open for others.** The hook's backend reads still use the `@/lib/backend` command-bound exports; 7001 converts them to the native-sessions domain client. `paneLayoutStore` calls `forgetAgentHandoff(id)` on the command scope (3013). `coordinatorActivityStore` (3011) can now call `subscribeNativeObservationInvalidations(listener, scope)` instead of its own per-scope events. 4002: with the shown node protected wholesale, the shown node's own older sessions are never evicted, so a single-node window whose node is shown can only refuse (collapse the writing session to its live tail) once the budget is full.
- **Where Effect is used, and where not.** Not used. The stores are synchronous zustand state read in render; the budget is 2001's `ByteBudget`; the slots' cleanup (the observation listener) runs through `scope.onDispose`, i.e. the scope's Effect-backed lifetime.
- **Outside the file set (minimal).** `lib/node-scope/byte-budget.ts` and its test (`evictUntil`, the transcripts default), `docs/development/node-scopes.md` (one bullet on heavy data reserving from the window budget), and one-line call-site conversions in `BugReportSheet.tsx`, `DesignAgentDialog.tsx`, `DesignWorkspaceDialog.tsx`, `design-prompt-images.tsx`, `AgentInfoButton.tsx`, `useCoordinatorGitActions.ts`, `NativeAsyncQuestionCard.tsx`, `use-interaction-resolver.ts`, `useAgentHandoff.ts`.
- **Aggregate suite** left to review preparation.

## Work log

- 2026-11-07 (claude-worker): converted `nativeAgentProjectionStore`, `nativeComposeStore` and `promptDraftStore` to scoped defs with the shim hook (barrel, `SHIMMED_STORES`); replaced `historyBytesTotal` with per-entry reservations in the window `transcripts` budget (`ByteBudget.evictUntil` added); threaded the node scope through `useNativeAgentSession` (store, capabilities, shared reads, observation events, change feed, read coordinator); moved `compose-draft-persistence`, `agent-handoff`, `native-session-shared-reads` and `native-observation-events` state into scoped slots with their commands on `backendApiForScope` factories; converted the `AgentNativeTab*` sites (and the `AgentNativeTab.tsx` config site) and the other component sites with a scope. Shim baseline: `native-agent-projection` 18 → 0, `native-compose` 52 → 6, `prompt-draft` 9 → 5. Tests: new `stores/agent-transcript-scopes.test.tsx` (8: per-node state, barrel, shared budget across two nodes with and without a shown node, window-wide reader room, dispose, per-node draft persistence, per-node handoffs and shared reads, the inactive-node path), `byte-budget.test.ts` +1 (`evictUntil`); `nativeAgentProjectionStore.test.ts` and the three `useNativeAgentSession.*` suites check budget reservations instead of `historyBytesTotal`. Focused runs: `src/hooks src/lib src/stores` plus `components/{native-agent,chat,design,bug-report,layout,projects,claude,kanban,terminal,linear,pane-layout}`: 9,814 tests, 9 failures, all in other agents' in-progress files (uiStore, workflow-stores-b, federation, scope-services, notification sounds). `tests/unit/source-guards.test.ts`: 3 failures, all other stores' registrations (design, ui, coordinator-activity) and pre-existing test-guard findings. Web typecheck: no errors in this item's files (other agents' in-progress files have some). oxlint and fmt clean on touched files.
