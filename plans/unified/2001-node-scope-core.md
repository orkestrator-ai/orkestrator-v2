---
id: 2001
title: "NodeScope, WindowScope and the scoped store and service primitives"
phase: 2
plan: "§5.1, §6.1, §7.2 and §12 Phase 2.1"
status: done
depends_on: []
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 2001 · NodeScope, WindowScope and the scoped store and service primitives

- **Report:** [§5.1 Scopes](../../docs/reports/unified-federation.md#51-scopes), [§6.1 `NodeClient`](../../docs/reports/unified-federation.md#61-the-nodeclient-contract), [§7.2](../../docs/reports/unified-federation.md#72-scoped-store-definitions), [§7.4](../../docs/reports/unified-federation.md#74-services-and-module-state)
- **Decisions:** 13.1 C (one tree, per-node instances), 13.2 B (explicit scope handle plus context)
- **Depends on:** none
- **Blocks:** most of Phases 2 and 3
- **Parallel with:** Phase 0, Phase 1, and the desktop main lane ([2006](2006-desktop-node-scopes.md))
- **Size:** M
- **Track:** S (scopes)

## Goal

The primitives every later item uses exist and are tested. Only the command scope exists at runtime, always live, so this item does not change behaviour.

## Current state (verified 2026-11-07)

- Zustand 5.0.15. No store in `apps/web/src/stores/` uses a factory. Factory and vanilla precedents:
  - `createRemoteOrderWrites(portal)` (`lib/federation/remote-order-writes.ts:33`) and `remote-project-writes.ts:90`
  - `PortalStore` (`lib/portal/portal-store.ts:73`, a class holding `readonly store: StoreApi<…>`, with a ref-counted `start()` returning stop)
  - `OperationRecovery` (`operation-recovery.ts:80`)
  - React reads these with `useStore(x.store, selector)`.
- There is no shared provider-wrapping test helper; the existing ones are feature-specific (`renderWithGraphEditor`, `renderPipelineTab`). Tests preload `tests/register-dom.ts` (happy-dom) and `tests/setup.ts` (resets at :90-93).

## Work

- [x] `packages/protocol/src/node-client.ts` (types only, browser-safe):
  - `NodeClient`, as in report §6.1;
  - `NodeConnectionState` (`connecting | live | resyncing | lapsed | failed`);
  - `NodeTerminalTransport`;
  - `ReadableSignal`.
  - The typed `invoke(def, args)` overload uses `@orkestrator/protocol/contract` types from [1002](1002-contract-primitives.md) when that has landed. Until then only `invokeRaw` and `listenRaw` are declared, with a box left on [2011](2011-scope-domain-negotiation.md) to add the typed overloads.
- [x] `apps/web/src/lib/node-scope/node-scope.ts`: `NodeScope { nodeId, role: "command" | "leaf", client, tier, store(def), service(def), dispose() }`.
  - Stores are created lazily and disposed with the scope.
  - Each scope owns one `AbortController` per service (§10.3).
- [x] `window-scope.ts`: `WindowScope` holds:
  - the node-qualified selection type `{ nodeId, projectId, environmentId }`;
  - the shared byte budgets: a `ByteBudget` class with `reserve(nodeId, key, bytes)` and `release` (for transcripts, artifacts and images, §7.4);
  - a registry of scopes by node id, with `commandScope()`.
- [x] `scoped-store.ts`: `defineScopedStore(name, (scope) => StateCreator)`, `useScopedStore(def, selector)` (reads the nearest provider), and `scope.store(def)`.
- [x] `scoped-service.ts`: `defineScopedService(name, (scope, signal) => { …; return { stop } })`. Its `start` and `stop` are idempotent. A thrown error stops only that service, records a content-free log event, and marks the scope `failed` (§10.3).
- [x] `providers.tsx`: `WindowScopeProvider` and `NodeScopeProvider nodeId`. `useNodeScope()` throws outside a provider in development and tests.
- [x] Mount `WindowScopeProvider` and a command-scope `NodeScopeProvider` at the root of `App.tsx`. The command scope's client wraps today's `window.orkestrator` until [2010](2010-command-scope-wiring.md).
- [x] Test helper `apps/web/src/test/render-in-node-scope.tsx`: `renderInNodeScope(ui, { nodeId?, role?, client? })` with a `FakeNodeClient` (invoke map, emit, connection signal). Add it to `docs/development/testing-guide.md`.

## Tests

- [x] Scope: lazy store creation, per-scope isolation (same def, two scopes, independent state), and dispose stops services and releases budget reservations.
- [x] Service failure isolation: a throwing service marks only its scope failed.
- [x] `ByteBudget`: a reservation over the total evicts least-recently-used keys from *other* nodes first, never the shown node (the policy hook is used by [4002](4002-hydration-tiers-and-budgets.md)).
- [x] Every timer or listener a scope starts is stopped in `afterEach` (invariant 15).

## Done when

- [x] Primitives are merged and mounted, and the browser smoke test passes with no visible change. Committed on this branch (stands in for main); browser smoke 2026-11-07 at `ee73894da`: 53 passed, the only failure the vim case that fails at base `148e9ad0a` on this host (see Work log). *(Split 2026-11-07 from "…, and `mise run test` and the browser smoke test pass …".)*
- [x] `mise run test` passes, with this exception. `mise run test` at `13d3b79ea` (2026-11-07, orchestrator): the workspace (web, backend, desktop, web-public, cli, protocol, toolchain), bridges and codex-lockfile groups pass; the root group fails only on tests that fail identically at the base `148e9ad0a`: `dom-absence-scan` (`NativeChart.test.tsx`, `RichBlockFrame.test.tsx`), the two `test-suite-ownership` checks (`e2e/agent-testing/session-history-environment.test.ts`, `tests/unit/tmux-mail-benchmark.test.ts`), and `goals-plan`/`graphs-plan`, which scan the `plans/goals` and `plans/graphs` folders the base deleted. None of these files is touched by this branch.

## Notes

- **API.** `packages/protocol/src/node-client.ts` (export `./node-client`, types only): `Unlisten`, `ReadableSignal<T> { get, subscribe }` (the `useSyncExternalStore` shape), `NodeConnectionState`, `NegotiatedDomainRange`/`NegotiatedDomains`, `NodeTerminalTransport { listenOutput(sessionId, handler), outputReady(sessionId) }` (input stays an ordered `invokeRaw`), and `NodeClient { nodeId, invokeRaw<T>, listenRaw<T>, eventStreamReady(event?), terminal, connection, domains, suspend, resume, dispose }`. The typed `invoke(def, args)` is not declared; [2011](2011-scope-domain-negotiation.md) already holds that box. `apps/web/src/lib/node-scope/`: `lifetime.ts` (`Lifetime`), `signal.ts` (`createSignal`, `constantSignal`), `byte-budget.ts` (`ByteBudget`, `createWindowByteBudgets`, `DEFAULT_WINDOW_BYTE_BUDGETS`), `node-scope.ts` (`NodeScope` with `store`, `service`, `onDispose`, `setTier`, `dispose`, and `tier`/`health` signals), `window-scope.ts` (`WindowScope` with `open`, `get`, `commandScope`, `select`, `nodeScopes`, `budgets`, `dispose`; `NodeSelection`), `scoped-store.ts` (`defineScopedStore`, `useScopedStore`), `scoped-service.ts` (`defineScopedService`, `ScopedServiceHandle`), `providers.tsx` (`WindowScopeProvider`, `NodeScopeProvider nodeId|scope`, `CommandNodeScopeProvider`, `useWindowScope`, `useNodeScope`, `useSignal`), `command-client.ts` (`createWindowOrkestratorClient`), `app-window-scope.ts` (`getWindowScope`, `resetWindowScopeForTests`, `COMMAND_SCOPE_PROVISIONAL_NODE_ID`).
- **Where Effect is used (2026-11-07).** Only in `lifetime.ts`, as the lifetime engine: the window owns a root `Scope.Closeable` (`Scope.makeUnsafe`), each node scope a child (`Scope.forkUnsafe`), and each running service a grandchild. Stores, budget release, client disposal and service stop/abort are `Effect.sync` finalizers added with `Scope.addFinalizer`; `dispose()` is `Effect.runSync(Scope.close(scope, Exit.void))`. Effect supplies reverse-order finalization, parent-closes-children, early-closed children detaching from the parent, and idempotent close. Callers never see Effect: `Lifetime` exposes synchronous `child`, `onClose`, `close` and `closed`, and each finalizer is wrapped so a throw is logged (`web.node-scope finalizer.failed`) and the rest still run. Measured cost: a minified bundle of just these `Scope`/`Effect`/`Exit` calls is 29.7 KB (10.3 KB gzip), now in `renderer-entry`.
- **Where Effect is deliberately not used.** Scoped services are not Effect `Layer`s or fibers. A service is plain TypeScript that receives an `AbortSignal` and returns `{ stop, done? }`: Zustand creators and React need synchronous starts and plain promises, and §10.3 asks for one `AbortController` per service. Stores are not `Context` services either; `scope.store(def)` is a keyed lazy cache of `createStore` instances. Signals, the byte budget, the providers and the command client are plain code, because each is a small synchronous structure that React reads directly.
- **Decision: the command scope's node id.** The renderer does not know the command node's installation id at mount time, so the command scope opens under `provisional:command-node` (`provisionalBackendId`). Code finds it with `commandScope()`, never by that id. [2010](2010-command-scope-wiring.md) puts in the proven id when it wires the client.
- **Decision: failure surface.** A service fails when `start` throws or its returned `done` rejects while the signal is not aborted. The scope's `health` signal becomes `{ state: "failed", failedServices }`. Starting the service again clears its entry (retryable). The log event `web.node-scope service.failed` carries only the service name, the scope role and `logErrorKind(error)`, never the message. The event was added to `packages/protocol/src/log-vocabulary/web-sync.ts` (area `web.node-scope`), a file outside this item's list, because the logger accepts only registered events.
- **Decision: byte budget at its limit.** If evicting every eligible entry (other nodes first, oldest first; then the reserving node's own older entries unless it is shown; never the shown node) still cannot make room, the reservation is refused and nothing is evicted. The budget is therefore a hard bound (invariant 11). Default totals (transcripts 64 MiB, artifacts 16 MiB, images 32 MiB) are placeholders until [0004](0004-measurement-report.md) and [4002](4002-hydration-tiers-and-budgets.md) set real ones; nothing reserves from them yet.
- **Decision: providers never open or dispose scopes** (invariant 2). `useNodeScope()` and `useWindowScope()` throw outside a provider when `import.meta.env` reports DEV, MODE `test` or NODE_ENV `test`. In production they fall back to the app's command scope. `NodeScopeProvider` throws when the window has no scope open for its `nodeId`.
- **Behaviour neutrality.** `App()` wraps `ConnectedApp` in `WindowScopeProvider` and `CommandNodeScopeProvider`. Nothing reads the scope yet. The command client reads `window.orkestrator` on every call and does not consult the prefetched-response cache, which moves onto the scope in [2010](2010-command-scope-wiring.md). Its `suspend` and `resume` do nothing; `dispose` drops only listeners registered through it.
- *(2026-11-07, orchestrator, completeness check: stale; the browser smoke suite was run later: `mise run test:agent:browser` at `ee73894da` and again at `9d061d7aa` (after the realm deletion), 53 passed, 1 failed, 124 skipped each time, the one failure the vim case that also fails at base `148e9ad0a` on this host ([4006](4006-multi-node-qualification.md) Notes); the aggregate `mise run test` is now its own open Done-when box.)* **Open: Done when.** This is not merged yet, and neither the aggregate `mise run test` nor the browser smoke test was run here. Focused guards run alongside (`tests/unit` test-suite-ownership, source-guards) fail on files this item does not touch (`e2e/agent-testing/session-history-environment.test.ts`, `tests/unit/tmux-mail-benchmark.test.ts`, backend and bridge source-guard baselines). They need separate triage.
- **Status (2026-11-07, orchestrator, completeness check).** Open only for the aggregate `mise run test` box, which the orchestrator runs at the end of the branch; everything else is done.

## Work log

- 2026-11-07 (claude-worker): added the `NodeClient` types and export, the `node-scope` primitives (Effect `Scope`-backed lifetimes, node and window scopes, byte budgets, scoped stores and services, providers, the command client over `window.orkestrator`), the root mount in `App.tsx`, `renderInNodeScope`/`FakeNodeClient` and the testing-guide section, and the `web.node-scope` log area. Tests: `apps/web/src/lib/node-scope` (7 files, 50 pass) plus `App.test.tsx` (171 pass across 8 files with the scope suites), and protocol `log-vocabulary` (18 pass). Web and protocol typechecks and `apps/web` build are clean. Done when is still open (merge, aggregate suite, browser smoke).
- 2026-11-07 (claude-worker, 2013 live pass): ran the browser smoke suite (`mise run test:agent:browser`) against a running `dev:test` profile `uf-2013-smoke` (started like the isolated runner: `--fixture --no-agent-credentials --agent-platforms codex`) at commit `6860254e8`: 51 passed, 3 failed, 124 skipped. The failures are all `e2e/agent-testing/terminal-input-resume.spec.ts`: one fails at base `148e9ad0a` on this host too (vim ruler), two are spec drift after 3008 made `terminalPortalStore.getTerminal` take a `nodeId` (the spec still calls `getTerminal(environmentId, tabId)`). The smoke run did not pass, so the smoke box stays open; it can be ticked after `terminal-input-resume.spec.ts` is updated for 3008 and a smoke run passes (the vim case excepted or fixed). Details and result files: [2013](2013-second-scope-proof.md) Notes, `output/agent-testing/uf-2013/`.
- 2026-11-07 (claude-worker, 4006): browser smoke `mise run test:agent:browser` at `4ece07c9a` against `uf-4006-smoke` (started as the isolated runner starts its own, flags and environment): 52 passed, 2 failed, 124 skipped. Failures: `terminal-input-resume.spec.ts` "a lost terminal write stays fenced …" (the vim status-line pattern that fails at base `148e9ad0a` on this host: pre-existing, environmental) and `browser-gateway.spec.ts` "capped file tree … across inactive views and reload" (390 px after a reload the projects drawer stays open after selecting the environment; passed at `6860254e8`, so a branch regression since; details in [4006](4006-multi-node-qualification.md) Notes). The smoke box stays open.
- 2026-11-07 (claude-worker, 4006 fixes): browser smoke `mise run test:agent:browser` at `ee73894da` against `uf-fix-smoke` (started as the isolated runner starts its own, flags and environment): 53 passed, 1 failed, 124 skipped. The one failure is `terminal-input-resume.spec.ts` "a lost terminal write stays fenced …" (the vim status-line pattern that fails at base `148e9ad0a` on this host: pre-existing, environmental); the capped-file-tree regression is fixed (`e46872643`). Results: `output/agent-testing/uf-fix/evidence/smoke/results.json`; details in [4006](4006-multi-node-qualification.md) Notes.
- 2026-11-07 (orchestrator, completeness check): the ticked Done-when box claimed `mise run test` passes, but no aggregate run is recorded. Split it: the proven part stays ticked, "`mise run test` passes" is its own open box (the orchestrator runs it at the end). `status: in-progress` until then.
- 2026-11-07 (orchestrator, completeness check): marked the "smoke not run" note stale (run at `ee73894da` and `9d061d7aa`).
- 2026-11-07 (orchestrator): ran the aggregate suite at `13d3b79ea`; result recorded in the Done-when box.
