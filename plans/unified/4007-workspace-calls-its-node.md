---
id: 4007
title: "Every workspace call goes to the workspace's node, with a guard"
phase: 4
plan: "§5.2, §7.3, §7.6 and §12 Phase 4"
status: done
depends_on: [4001]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 4007 · Every workspace call goes to the workspace's node, with a guard

- **Report:** [§5.2 The React shape](../../docs/reports/unified-federation.md#52-the-react-shape), [§7.3 shim and ratchet](../../docs/reports/unified-federation.md#73-the-migration-shim-and-its-ratchet), [§7.6 Lint boundaries](../../docs/reports/unified-federation.md#76-lint-boundaries)
- **Depends on:** [4001](4001-in-tree-workspace-seam.md)
- **Blocks:** [4006](4006-multi-node-qualification.md) (feature parity for an in-tree leaf)
- **Size:** M
- **Track:** S (scopes)

## Goal

An in-tree leaf workspace sends every command to its own node. Today the store shims are at zero, but components and hooks inside the workspace subtree still import command-bound `@/lib/backend` exports, which always reach the command node.

## Current state (verified 2026-11-07)

Found while doing [4001](4001-in-tree-workspace-seam.md):

- A heuristic scan (`output/agent-testing/4001/command-bound-survey.py`, not committed) flags about 88 workspace component and hook files that call command-bound `@/lib/backend` exports. Some are false positives.
- No guard catches them. `lib-backend-command-default` ([3002](3002-lib-backend-client-parameter.md)) covers only modules that define scoped state; [4004](4004-runtime-shim-guard.md) sees only store shims.
- Two areas were deferred as wholes by 4001:
  - the design canvas: all of `designApi` and its helpers, which must move together so one canvas never splits its operations across two nodes;
  - `lib/claude-tmux-client.ts` (about 20 functions) and leaf prompt-queue restore, which depends on it.
- `backendForScope(scope)` (`lib/backend/scope-backend.ts`, 4001) gives every backend function for one node, and is the module itself on the command scope, so existing mocks keep working.

## Work

- [x] A shrink-only source guard `workspace-command-bound-call`: inside the workspace import graph (from `WorkspaceContent`/`ProjectWorkspace`, as 3013 traced it), count uses of command-bound `@/lib/backend` exports. Window-level and command-only modules are exempt and listed.
- [x] Convert every flagged file to its scope's backend (`backendForScope(useShimNodeScope(...))`, `backendApiForScope`, or the domain clients), until the guard's baseline is zero for the workspace graph.
- [x] Move the design canvas's `designApi` calls and helpers to the canvas's scope, together.
- [x] Bind `lib/claude-tmux-client.ts` to a scope, with a per-scope event listener; restore a leaf's prompt queues from the leaf.

## Tests

- [x] For a representative component in each area (agent tab, terminal, files, previews, design, tmux, mail, Kanban, PRs), rendered in a leaf scope, every command reaches the leaf's fake client and none reaches the command client.
- [x] The guard's baseline is committed and fails on a new command-bound call in the workspace graph.

## Done when

- [x] The guard's baseline is zero for the workspace graph, and the representative tests pass.

## Notes

- 2026-11-07 (orchestrator): created from 4001's finding. Without it, an in-tree leaf would send part of its traffic to the command node, so 4006's parity check depends on it.
- **API (2026-11-07).**
  - Guard `workspace-command-bound-call` (`tests/source-guards/workspace-command-bound-call.ts`, registered in `guard.ts`/`scan.ts`): `WORKSPACE_ROOT_MODULES` (`components/layout/WorkspaceContent`, `NodeWorkspaceLayout`, `OpenFileDialog`, `components/agent-mail/AgentMailPanel`), `workspaceGraph(readModule, roots?, exempt?)` (value imports, re-exports and `import()`, not following `lib/backend/**`, `lib/node-scope/**`, `src/test/**`, test sources or exempt modules), `WORKSPACE_EXEMPT_MODULES` (module → reason), `WORKSPACE_WINDOW_LEVEL_EXPORTS` (subject → name → reason), `commandBoundSubject(moduleId)`, `createWorkspaceCommandBoundCallGuard({ readModule, roots, exempt, windowLevelExports })`. Keys `[subject] file`; subject is the `lib/backend` file, or the module under `src/` for any other renderer module's export bound to `commandBackendClient`/`portalBackendClient`. `lib-backend-command-default.ts` gained `libBackendSubject`, a `subjectOf` parameter on `LibBackendShimResolver` (default unchanged) and an `allowed(subject, name)` parameter on the exported `visitShimUses`. Test: `tests/unit/workspace-command-bound-call-guard.test.ts` (8).
  - `hooks/useScopeBackend.ts`: `useScopeBackend(): ScopeBackend` (= `backendForScope(useScopesWithCommandFallback().scope)`), `useScopeApi(createXApi, namespace)` for `lib/backend` files outside the barrel (`graph-launch`, `graph-mock`).
  - `lib/claude-tmux-client.ts`: `createClaudeTmuxClient(client: BackendClient, events: TmuxEventSource)`, `type TmuxEventSource`, `type ClaudeTmuxClient`; the named exports are `createClaudeTmuxClient(commandBackendClient, windowTmuxEvents)`. `lib/claude-tmux-scope.ts`: `claudeTmuxClientFor(scope)` (the module itself on the app's command scope, so suites that mock it keep working; otherwise a `"claude-tmux-client"` slot over `scopeBackendClient(scope)` and `listenInScope(scope, "claude-tmux:event", …)`), `useClaudeTmuxClient()`. `autoAllowPermissionHook(tmux, tabId, …)`.
  - Design: `designApi` removed; `designApiFor(scope)` is the only v2 API. `designAction(env, action, input, scope)` and `importDesignDocument/importDesignHostFile(…, scope)` take the node; `designBackendKeyFor(scope)`; `designReadinessDeps(scope)`, `loadDesignReadiness(probe, deps)`, `runDesignLifecycle(…, api)`, `designLibraryClient(scope)`, `openDesignFile(…, { openFile, reportError? })` take it too. `components/design/design-scope.ts`: `useDesignScope()` (`useShimNodeScope(designStore.name)`, as `useDesignCanvas`), `useDesignApi()`. `getCapabilities(backend?, scope?)` keeps 3016's optional scope (its tests use it); every production caller passes the node.
  - Graph runs: `requestGraphRunView(request, scope?)`, `onGraphRunViewRequested(listener, scope?)`, `takePendingGraphRunView(environmentId?, scope?)` on a `"graph-run-view-requests"` slot; `openLaunchedGraphRun({ …, scope })`. Callers pass their node (terminal container, Multi Review, coordinator work targets, graph designer, Run graph button, Kanban).
  - Prompt queues and boot hydration: `createPromptQueueSources(scope?)` (a `"prompt-queue-sources"` slot over `scope.store(claudeTmuxStore)`), `enqueueAgentPrompt/removeAgentPrompt/moveAgentPrompt/retryAgentPromptQueueDispatch(…, scope?)`; `retryPromptQueueDispatch`, `hydratePromptQueuesForEnvironment`, `hydratePromptQueue` take their loader (no command default); `environmentHydrationFor(scope?)` (one batcher per scope), `hydrateBootMultiReviewWorkflows(id, batcher?, scope?)`. `useNodeBootHydration(scope)` restores every node's prompt queues and reviews through its own batcher. The `prompt-queues` store-resource handler is `every-scope`.
  - Plain helpers take the node: `readWholeRepresentation(reader, …)`, `verifyArtifactConversation(scope, reader)`, `readVerifiedEffectiveHtml(reader, …)`, `readArtifactLedger(scope, reader)`, `type ArtifactReader`; `resolveMedia/resolveMediaUrl(ref, { scope })` (reads and caches keyed by `scope.nodeId`); `MermaidRenderOptions.node`; `processClipboardPaste/processLocalClipboardPaste(writer, …)`, `TerminalPasteOptions.writer`, `type ClipboardImageWriter`; `loadEnvironmentImage(target, signal?, scope?)`; `openServiceExternally(target, { opener?, scope? })`; `reportCoordinatorPullRequest(…, now?, scope?)`; `UpstreamCheckOptions.scope`; `saveInitialPromptAttachments({ …, backend })`; `backendMcpServerSource(backend)`, `loadConfiguredUserMcpServers(source)`.
- **Baseline.** 296 command-bound uses in 108 files (134 keys) at registration (commit 272079a8f), not counting the tmux client's ~34 uses, which the guard saw once the client became a factory. Now **0**. Exempt: `components/settings/agent/refresh-model-catalog` (Global Settings' catalogue refresh; the workspace imports only its event name) and `stores/nativeNoticeDismissalStore` (an unscoped window store: this client's dismissals, kept with its client state on the command node; scoping it is a store conversion). Window-level: `config-integrations` `openInBrowser` (opens on the window's machine: desktop shell, the browser tab, or the command node hosting this client).
- **Decision: what "the workspace" is for the guard (2026-11-07).** Options: (a) directories (`components/**`, `hooks/**`): they hold window code too (settings, sidebar), so the baseline could never honestly reach zero; (b) 3013's import graph from the workspace roots, with listed exemptions whose imports are not followed (chosen): it is exactly what an in-tree leaf renders, and a window-level module enters only by being imported from the workspace; (c) a runtime check like 4004's: it only sees calls a test exercises. The graph is ~950 modules and costs ~0.2 s per scan.
- **Decision: what counts as command-bound (2026-11-07).** The 3002 shims, plus any renderer module's exported `const` bound to `commandBackendClient`/`portalBackendClient`, read from the sources (so the tmux client entered by becoming a factory). Functions with an optional trailing `scope` (3003's convention, the command scope when omitted) are not counted: the guard cannot tell a forgotten scope from a deliberate window call. The design client therefore drops its command defaults instead of being listed, and every workspace caller of an optional-scope helper passes its node (listed under API).
- **Decision: the scope hook (2026-11-07).** `useScopeBackend()` reads `useScopesWithCommandFallback()` as 4001's conversions did: no shim note outside a provider, and suites that render without one keep reaching their `@/lib/backend` mocks. Tests that render in their own scope now see the calls on that scope's client: `build-chat-tab-test-support.tsx`'s `FakeNodeClient` forwards the pipeline control commands to the suite's stubs (3011's pattern).
- **Decision: default parameters.** A `{ load = backend.getX }` default became `{ load: loadOverride }` plus `const load = loadOverride === undefined ? nodeBackend.getX : loadOverride`, keeping `null` meaningful (`ReviewValidationStatus stopCommand={null}`).
- **Mechanics.** A one-off oxc codemod (`output/agent-testing/4007/codemod.ts`, not committed) rewrote uses inside components and hooks to `nodeBackend.X`, added the hook and the hook dependencies, converted destructured defaults, and dropped or narrowed the imports; plain helpers were done by hand.
- **Where Effect is used, and where not.** Not used. The per-scope pieces are `defineScopedSlot`s and `backendForScope`/`backendApiForScope` memos, which already live on the scope's Effect-backed lifetime; the guard is a synchronous AST scan like its siblings.
- **For the orchestrator / follow-ups.** (1) Change-feed subscriptions in workspace modules that name no scope (`onResourceChanged`/`onResourceResync`/`onViewSafetyCheck` without the trailing scope) listen to the command node's feed; fixed here in `GraphRunTab` and `useArtifactPublications`. Candidates to check (some already pass a scope): `WorkflowLiveInspector`, `ArtifactDraftInspector`, `GraphDescribeControl`, `GraphDesignerTab`, `GraphTemplateReviewPanel`, `GraphRunsList`, `useCoordinatorActiveTurn`, `useCoordinatorPanelData`, `usePermissionRuleSession`, `useRemoteHumanPrompts`, `useUserCommands`, `useWorktreeSnapshotRevisions`, `useProjects`. A guard for them would count calls with fewer arguments than the scope position. (2) `prompt-queue-persistence`'s revision and dispatch-error maps are module-level, keyed by queue key (agent + `environmentId:tabId`), so two nodes collide only with identical environment ids. (3) Mermaid diagrams now render on the transcript's node. (4) 4006 can rely on this item's guard and `WorkspaceLeafCalls.scopes.test.tsx`.
- Aggregate suite (`mise run test`) left to review preparation.

## Work log

- 2026-11-07 (claude-worker): added the `workspace-command-bound-call` guard (baseline 296) and moved every flagged workspace component, hook and helper onto its node (`useScopeBackend`, `useScopeApi`, explicit node parameters) until the baseline is 0; bound the Claude tmux client to a scope with a per-node event stream (`claudeTmuxClientFor`); per-scope prompt-queue sources, mutations, boot batcher and change handler, so a leaf restores and follows its own prompt queues; moved the whole design canvas surface to its node and removed the command-bound `designApi`; made graph-run view requests per scope. Docs: `node-scopes.md` (workspace calls table, the guard), `linting.md` (the guard), `design-canvas.md` (client paragraph). Tests: new `tests/unit/workspace-command-bound-call-guard.test.ts` (8: graph, counting, window-level exports, exemptions, ratchet failure on a new call, subjects, real graph, committed baseline), new `components/layout/WorkspaceLeafCalls.scopes.test.tsx` (10: agent tab, terminal, files, previews, design, tmux with per-node events, mail, Kanban, PRs, graph runs; each in a leaf scope with the in-tree leaf mount, nothing on the command scope's client or the app's `invoke`), a per-node case in `graph-run-navigation.test.ts`; updated the clipboard paste, terminal paste, static HTML, artifact ledger, initial prompt attachment, store-resource-sync, design workspace and build-chat-tab suites for the new parameters. Whole web suite (`bun --cwd=apps/web test src --parallel=4`): pass. `tests/unit/{components,hooks,lib,stores}`: pass. `tests/unit/source-guards.test.ts`: only the pre-existing test-source findings. Web typecheck clean on this item's files (another agent's `lib/node-snapshots.ts` was mid-edit at the end); fmt and oxlint clean on touched files. Commits: 272079a8f, 08be59c32, f3e309b42, 5a920b2f0, 0304680ec, 7cc560bfd and the docs/item commit.
