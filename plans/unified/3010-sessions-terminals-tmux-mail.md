---
id: 3010
title: "Convert session, terminal session, Claude tmux and agent mail stores"
phase: 3
plan: "§12 Phase 3.4"
status: done
depends_on: [3008, 3009]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 3010 · Convert session, terminal session, Claude tmux and agent mail stores

- **Report:** [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [3008](3008-terminal-portal-and-artifact-hosts.md), [3009](3009-agent-and-transcript-stores.md) (`claudeTmuxStore` calls `promptDraftStore`)
- **Blocks:** [3013](3013-pane-layout-store.md)
- **Size:** L
- **Track:** S (scopes)

## Stores (verified 2026-11-07)

| Store | LOC | Imperative sites | Notes |
|---|---|---|---|
| `sessionStore` | 458 | 4 | |
| `terminalSessionStore` | 258 | 16/2 | **missing from the report's hot spots**; mostly `components/terminal/TerminalContainer.view.tsx`, which has 32 sites across stores |
| `claudeTmuxStore` | 1,395 | 11/3 | calls `promptDraftStore` 5 times (:426-626); `lib/claude-tmux-client` uses `@/lib/native/backend` |
| `agentMailStore` | 279 | 17/13 | |

## Work

- [x] Convert the four stores. The terminal transport comes from `scope.client.terminal`.
- [x] Convert `TerminalContainer.view.tsx` and `PersistentTerminal.tsx` (scan the latter with the parser; grep treats it as binary).
- [x] `claudeTmuxStore` calls the scope's `promptDraftStore`, not the shim.

## Tests

- [x] A terminal on node B uses B's terminal transport, and terminal input sequencing is per node.
- [x] Existing terminal and tmux suites pass. (Focused suites; aggregate suite left to review preparation, see Notes.)

## Done when

- [x] All four stores are converted, and `TerminalContainer.view.tsx` has no shim calls.

## Notes

- **API (2026-11-07).**
  - `stores/sessionStore.ts`: `sessionStore = defineScopedStore<SessionState>("session", …)`, `useSessionStore = scopedStoreHook(sessionStore)`, `SessionState` exported. The three module singletons (`activeSessionLoadRequests`, `nextSessionSnapshotGeneration`, `sessionStatusQueues`) are closure state of each instance, so a load or a status write on one node never supersedes another's. Commands through `backendApiForScope(scope, createFilesSessionsApi, { … })` (the named exports on the app command scope, read per call).
  - `stores/terminalSessionStore.ts`: `terminalSessionStore = defineScopedStore<TerminalSessionStore>("terminal-session", …)`, `useTerminalSessionStore = scopedStoreHook(…)`, `TerminalSessionStore` exported. No backend calls.
  - `stores/claudeTmuxStore.ts`: `claudeTmuxStore = defineScopedStore<ClaudeTmuxState>("claude-tmux", …)`, `useClaudeTmuxStore = scopedStoreHook(…)`, `ClaudeTmuxState` exported. Its five prompt-draft sweeps call `scope.store(promptDraftStore)` (`prompt-draft` shim 5 → 0). `migrateLegacyClaudeTmuxState(legacyTabId, scopedKey, environmentId, scope?)` (optional trailing scope, 3003's convention).
  - `stores/agentMailStore.ts`: `agentMailStore = defineScopedStore<AgentMailState>("agent-mail", …)`, `useAgentMailStore = scopedStoreHook(…)`, `AgentMailState` exported. The module singletons (`mailboxGeneration`, `requestedMailboxes`, `pendingMailboxes`) are closure state of each instance. New actions `refreshObservedMailboxes()` and `requestMailbox(environmentId, tabId)`; the free functions stay with an optional trailing scope: `refreshObservedAgentMailMailboxes(scope?)`, `requestAgentMailMailbox(environmentId, tabId, scope?)`. Reads through `backendApiForScope(scope, createAgentMailApi, { … })`.
  - All four defs are in the `@/stores` barrel beside their hooks (`sessionStore` and `claudeTmuxStore` were not exported there before) and in `SHIMMED_STORES`.
  - `lib/node-scope-slots.ts` (additive): `onReconnectInScope(scope, handler) → Promise<UnlistenFn>`. The app command scope keeps `native-event-stream-connected` (what suites emit); any other scope follows `scope.client.connection` into `live` (the state at subscription is not a reconnect). Used by `useTerminal` and `TerminalContainer.view`.
  - `hooks/useTerminal.ts`: the hook reads its node with `useShimNodeScope("terminal-session")`. `terminalBackendForScope(scope)` (exported) is its 16 terminal commands (`createTerminalsApi` + the local-terminal half of `createWorkflowsApi`, both through `backendApiForScope`). Output: the app command scope keeps the window `listen`; any other scope listens through `scope.client.terminal.listenOutput(sessionId, …)` with `outputReady` as the readiness wait (through `listenOn`, so the abort and the readiness timeout are unchanged). Reconnect re-reads: the two window events on the command scope, `onReconnectInScope` elsewhere. Input to node B therefore goes through B's client and B's transport, whose `TerminalInputSequencer` orders it (`lib/native/node-transport.ts`, one per node).
  - `components/agent-mail/agent-mail-ui.ts`: `useAgentMailScope() → { scope, api: AgentMailApi }` (`backendApiForScope(scope, createAgentMailApi, backend)`); `openAgentMailForTab(environmentId, tabId, mode?, scope?)`, `openAgentMailConversation(a, b, scope?)`. The panel, banner, conversation view and delivery settings send their mail commands through it. The banner's single in-flight summary read is keyed by the scope's store action (a `WeakMap`), not one module promise.
  - `TerminalContainer.helpers.seedDeferredNativePlatform(tab, platform, scope)` takes its scope (`native-compose` 2 → 0 there, 3009's leftover).
- **Shim counts (`scoped-store-shim`, 2026-11-07).** At conversion (stores converted, no site changed): `session` 4 in 2 files, `terminal-session` 17 in 5 files, `claude-tmux` 10 in 3 files, `agent-mail` 11 in 4 files (the plan's 16/11/17 counted differently: `.ts` vs total, and 3014 had moved some). **Now: `session` 0; `terminal-session` 1 in 1 file; `claude-tmux` 2 in 1 file; `agent-mail` 0.** Also `prompt-draft` 5 → 0, `config` `ClaudeTmuxChatTab.tsx` 1 → 0 (3005's leftover), `native-compose` `TerminalContainer.helpers.ts` 2 → 0. The three left are `stores/paneLayoutStore.ts` (`cleanupLocalTabResources` and the tmux tab teardown), plain code in the command-scope pane layout that 3013 scopes next; the brief keeps edits there minimal, so they are 3013's. `TerminalContainer.view.tsx` has no shim use of any store. `lib-backend-command-default`: `[agent-mail] lib/store-resource-sync.ts` 1 → 0 (the summary read is a factory call now).
- **Decision: which scope the call sites use (2026-11-07).** Same as 3003/3004/3009: components and hooks use `useShimNodeScope(def.name)` / `useScopedStoreApi(def)`, because their suites (`TerminalContainer.*`, `PersistentTerminal`, `ComposeBar`, the tmux and mail suites) still render without a provider; plain code takes a scope parameter (`bindSetupTerminalSession(environment, sessionId, scope)` in `useEnvironments.ts`). `AgentInfoButton` passes its existing `useScopesWithCommandFallback` scope; `MailToolPart` asks its own scope's store for the recipient mailbox.
- **Decision: the change handlers stay in `store-resource-sync.ts`, rewritten in place (2026-11-07).** Options: (a) move each registration into its store module (the recipe): `defineStoreResourceHandlers` there is an `import/no-cycle` with `STORE_RESOURCE_HANDLERS`, as 3004/3005 found; (b) a separate module importing the framework's types only (3004's `project-environment-resource-handlers.ts`); (c) rewrite in place. Chose (c), as 3005 did for `config`: the two registrations are small and touch nothing else. `sessions` and `agent-mail` are `every-scope` now and read `context.scope.store(sessionStore | agentMailStore)`; the `config` registration clears its own scope's agent mail when messaging is off (it cleared only on the command scope before).
- **Decision: the terminal transport for the command scope (2026-11-07).** Options: (a) every scope, the command one included, through `scope.client.terminal`; (b) the command scope keeps the window `listen` and `@/lib/backend` named exports, other scopes their client. (a) changes nothing at runtime (the command scope's client is the same transport) but every terminal suite mocks `@/lib/native/events` and `@/lib/backend`. Chose (b), the same split `backendApiForScope` and `listenInScope` make.
- **Prompt queues stay on the command node.** `lib/prompt-queue-sources.ts` passed `useClaudeTmuxStore` itself as its store object (an alias the guard cannot see). It now names the command scope explicitly (`appCommandScope().store(claudeTmuxStore)`, per call; same behaviour). Scoping prompt queues (the sources, `prompt-queue-persistence`, the `prompt-queues` registration) is open: until then a tmux tab under another node's provider would not see its queue projection.
- **Open for others.** (1) `lib/claude-tmux-client.ts` is still bound to `commandBackendClient` and the window `listen`, so `ClaudeTmuxChatTab`'s tmux commands and events reach the command node; a leaf tab needs `claudeTmux(scopeBackendClient(scope))` (7002's domain client) and `listenInScope` for `claude-tmux:event` (4001, or a follow-up to this item). (2) The agent-mail panel's open state is per node; `AgentMailPanel` renders under the app's command scope, so a leaf's tab opening mail needs the panel rendered in its node scope too (4001). `DraggableTab` and `MailTile` still call `openAgentMailForTab`/`openAgentMailConversation` without a scope (the default is the command scope). (3) `TerminalContainer.view`'s setup-session lookups (`backend.awaitEnvironmentSetupSession`, `getSessionsByEnvironment`, `loadSessionBuffer`) still use the command-bound exports. (4) `paneLayoutStore`'s three sites (3013).
- **Test fix.** `PersistentTerminal.test.tsx` mocks `@/stores/sessionStore`; the mock now also exports a test-only `sessionStore` def (`"session-test-mock"`) whose state is the mock object, because the component's imperative reads go through its scope's instance.
- **Where Effect is used, and where not.** Not used. The stores are synchronous zustand state read in render; their per-node bookkeeping is closure state of each instance, which dies with the scope (2001's Effect-backed lifetime). The reconnect helper is a plain signal subscription; the terminal output path reuses `listenOn`'s abort and readiness timeout rather than an Effect `Schedule`, because the hook's reconnect and reconcile logic is already promise-based and tested.
- **Outside the file set (minimal).** `lib/node-scope-slots.ts` (one helper), `hooks/useEnvironments.ts` (one function's scope parameter, 3004's file), `lib/prompt-queue-sources.ts` (the alias), `components/chat/MailToolPart.tsx` and `components/layout/AgentInfoButton.tsx` (one call each), `hooks/useTerminal.ts`.
- **Aggregate suite** left to review preparation. Cross-file failures in `tests/unit` (32 when `ClaudeTmuxChatTab*`, `NativeChatScrollWiring`, `uncovered-stores`, `useEnvironments` and others run in one process) are identical (483 pass, 32 fail) on this branch's tree without this item's files, checked in a scratch worktree; they come from module mocks leaking between files and from 3004's/3008's signature changes (`uncovered-stores` `createPortalTargetKey`, `useEnvironments` `listenInScope`).

## Work log

- 2026-11-07 (claude-worker): converted `sessionStore`, `terminalSessionStore`, `claudeTmuxStore` and `agentMailStore` to scoped defs with the shim hook (barrel, `SHIMMED_STORES`), their module state into per-instance closures, their commands onto `backendApiForScope` factories; `claudeTmuxStore` sweeps its own scope's prompt drafts; converted every imperative site with a scope (`TerminalContainer.view`, `PersistentTerminal`, `ComposeBar`, `ClaudeTmuxChatTab` and `.parts`, the agent-mail panel, banner, conversation view, delivery settings and `agent-mail-ui`, `useEnvironments`, `store-resource-sync`), plus 3005's `ClaudeTmuxChatTab` config site and 3009's `seedDeferredNativePlatform`; `useTerminal` sends its commands and reads its output and reconnects through its scope's client (`scope.client.terminal`); `sessions` and `agent-mail` change handlers are `every-scope`; `onReconnectInScope` added. Shim baseline: `session` 4 → 0, `terminal-session` 17 → 1, `claude-tmux` 10 → 2, `agent-mail` 11 → 0, `prompt-draft` 5 → 0 (`update-baseline.ts --guard scoped-store-shim --guard lib-backend-command-default`). Tests: new `hooks/useTerminal.scopes.test.tsx` (3: B's commands and terminal transport with A untouched, input ordered per node, B's reconnect re-read), new `stores/session-terminal-mail-scopes.test.tsx` (17: per store two scopes, the hook under `renderInNodeScope`, the statics on the command scope; barrel; sessions load from their node; a resolved tmux prompt clears its own node's draft; agent mail reads, batches and clears per node; a leaf scope's own sync keeps its sessions and mail). Focused runs: `apps/web` stores/hooks/terminal/agent-mail/claude/store-resource-sync/scope-services/prompt-queue/mail suites pass; `tests/unit` tmux, compose bar, sidebar and environment suites: each file passes alone except two pre-existing failures, and the combined run matches the tree without this item (483/32). Web typecheck: no errors in this item's files (others' in-progress files have some). fmt and oxlint clean on touched files.
