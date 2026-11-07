---
id: 2001
title: "NodeScope, WindowScope and the scoped store and service primitives"
phase: 2
plan: "§5.1, §6.1, §7.2 and §12 Phase 2.1"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
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

- [ ] `packages/protocol/src/node-client.ts` (types only, browser-safe):
  - `NodeClient`, as in report §6.1;
  - `NodeConnectionState` (`connecting | live | resyncing | lapsed | failed`);
  - `NodeTerminalTransport`;
  - `ReadableSignal`.
  - The typed `invoke(def, args)` overload uses `@orkestrator/protocol/contract` types from [1002](1002-contract-primitives.md) when that has landed. Until then only `invokeRaw` and `listenRaw` are declared, with a box left on [2011](2011-scope-domain-negotiation.md) to add the typed overloads.
- [ ] `apps/web/src/lib/node-scope/node-scope.ts`: `NodeScope { nodeId, role: "command" | "leaf", client, tier, store(def), service(def), dispose() }`.
  - Stores are created lazily and disposed with the scope.
  - Each scope owns one `AbortController` per service (§10.3).
- [ ] `window-scope.ts`: `WindowScope` holds:
  - the node-qualified selection type `{ nodeId, projectId, environmentId }`;
  - the shared byte budgets: a `ByteBudget` class with `reserve(nodeId, key, bytes)` and `release` (for transcripts, artifacts and images, §7.4);
  - a registry of scopes by node id, with `commandScope()`.
- [ ] `scoped-store.ts`: `defineScopedStore(name, (scope) => StateCreator)`, `useScopedStore(def, selector)` (reads the nearest provider), and `scope.store(def)`.
- [ ] `scoped-service.ts`: `defineScopedService(name, (scope, signal) => { …; return { stop } })`. Its `start` and `stop` are idempotent. A thrown error stops only that service, records a content-free log event, and marks the scope `failed` (§10.3).
- [ ] `providers.tsx`: `WindowScopeProvider` and `NodeScopeProvider nodeId`. `useNodeScope()` throws outside a provider in development and tests.
- [ ] Mount `WindowScopeProvider` and a command-scope `NodeScopeProvider` at the root of `App.tsx`. The command scope's client wraps today's `window.orkestrator` until [2010](2010-command-scope-wiring.md).
- [ ] Test helper `apps/web/src/test/render-in-node-scope.tsx`: `renderInNodeScope(ui, { nodeId?, role?, client? })` with a `FakeNodeClient` (invoke map, emit, connection signal). Add it to `docs/development/testing-guide.md`.

## Tests

- [ ] Scope: lazy store creation, per-scope isolation (same def, two scopes, independent state), and dispose stops services and releases budget reservations.
- [ ] Service failure isolation: a throwing service marks only its scope failed.
- [ ] `ByteBudget`: a reservation over the total evicts least-recently-used keys from *other* nodes first, never the shown node (the policy hook is used by [4002](4002-hydration-tiers-and-budgets.md)).
- [ ] Every timer or listener a scope starts is stopped in `afterEach` (invariant 15).

## Done when

- [ ] Primitives are merged and mounted, and `mise run test` and the browser smoke test pass with no visible change.
