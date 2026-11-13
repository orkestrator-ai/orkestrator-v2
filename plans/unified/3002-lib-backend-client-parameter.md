---
id: 3002
title: "lib/backend functions take a NodeClient"
phase: 3
plan: "§7.4 lib/backend"
status: done
depends_on: [2010]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 3002 · lib/backend functions take a NodeClient

- **Report:** [§7.4](../../docs/reports/unified-federation.md#74-services-and-module-state) (the `lib/backend/*` bullet)
- **Depends on:** [2010](2010-command-scope-wiring.md)
- **Blocks:** the store items that call these functions ([3003](3003-stores-batch-a-leaf-light.md) onward)
- **Parallel with:** [3001](3001-scoped-store-shim-and-ratchet.md), Phase 7 (they meet here)
- **Size:** M (mechanical, large)
- **Track:** S (scopes)

## Goal

A scoped store can call every backend helper on its own node, by passing its client explicitly.

## Current state (verified 2026-11-07)

- `apps/web/src/lib/backend/` has 37 source files (8,226 LOC; the report says ~9.1k) and 10 tests, with 778 `export` declarations (the report says ~681).
- The barrel `lib/backend.ts` has 31 lines.
- There are 250 non-test importers: 213 via `@/lib/backend`, 44 via `@/lib/backend/*`.

## Work

- [x] Choose the signature by file and record the choice in Notes. Recommended:
  - a factory per file, `createEnvironmentsApi(client)`, returning the same function names;
  - plus the existing named exports bound to the command scope as the shim.
  - This keeps every caller compiling, and lets a store do `const api = createEnvironmentsApi(scope.client)`.
- [x] Convert all 37 files mechanically, behaviour-neutral. Do it file by file in a few PRs, grouped by domain so Phase 7 can later replace the bodies with domain clients.
- [x] Source guard `lib-backend-command-default`: counts uses of the command-bound named exports from inside converted stores' modules and services. The baseline only shrinks, as in [3001](3001-scoped-store-shim-and-ratchet.md).

## Tests

- [x] Each converted file's existing tests pass. Add one test per factory proving that a passed client is used rather than the command scope.

## Done when

- [x] Every `lib/backend` file exposes a client-taking factory.

## Notes

- **API (2026-11-07).** Every `apps/web/src/lib/backend/<x>.ts` with a command exports:
  - `createXApi(client: BackendClient)` (PascalCase of the file name: `createProjectsEnvironmentsApi`, `createWorkflowsApi`, `createCommandNodesApi`, ...), returning the file's command functions with their names, signatures and JSDoc unchanged, bound to `client`'s node.
  - `export type XApi = ReturnType<typeof createXApi>`.
  - The named exports as `export const { a, b, ... } = createXApi(commandBackendClient)`: the shim. Arity is unchanged (the `backend.test.ts` arity sweep still drives every one).
  - Types, constants and helpers that send nothing (for example `getWebClientStatus`, which talks to the desktop host, or `listMachineAgentAccounts`, which is a command-node setting) stay at module level and are not in the factory.
- **`apps/web/src/lib/backend/client.ts` (new, not in the barrel).**
  - `BackendClient = Pick<NodeClient, "invokeRaw">`, so `scope.client` (any `NodeClient`) is one.
  - `commandBackendClient`: `@/lib/native/backend` `invoke`, read at call time and given the arguments exactly as passed (a one-argument call stays one-argument), so the prefetched cache applies and every suite that mocks that module, or asserts `toHaveBeenLastCalledWith("cmd")`, sees the same calls as before.
  - `portalBackendClient`: `portalInvoke`, the shim client of `command-nodes.ts`, which talks to the command node over the portal channel (unchanged behaviour).
  - `clientInvoke(client)`: the `invoke` shape the factory bodies call (`const invoke = clientInvoke(client)` at the top of each factory, so the bodies are untouched).
  - `scopeBackendClient(scope)`: the app's command scope is `commandBackendClient`; any other scope is `invokeInScope(scope, ...)`, so that scope's prefetched cache applies.
  - `backendApiForScope(scope, createXApi, { getX })`: the given command-bound functions on the app's command scope (what suites mock), otherwise `createXApi(scopeBackendClient(scope))`, made once per scope (a `WeakMap` keyed by scope, then by factory).
  - `machineInvoker(client)` and the `AccountMachine`/`MachineInvoke` types: `machineInvoke` over a client. `undefined` is the client's own node, `null` the command node (`portalInvoke`), a node id goes through `portalStore.invokeOnNode`. `agent-accounts.ts` keeps `machineInvoke = machineInvoker(commandBackendClient)` (used by `lib/web-annotations/client.ts`) and re-exports `AccountMachine`.
- **Decision: the signature (2026-11-07).** Options:
  - (a) A trailing optional `client` parameter on every function. Many functions already end in optional parameters (`machine?`, `options?`), so a trailing client is ambiguous, and it changes every arity the `backend.test.ts` sweep relies on.
  - (b) A leading `client` parameter with a bound shim per function. It doubles every export (`getX(client, ...)` and `getX(...)`), so ~1,300 names.
  - (c) A factory per file returning the same names, with the named exports as the factory over the command scope (the item's recommendation). Every caller compiles unchanged; a store does `const api = createEnvironmentsApi(scope.client)`.

  Chosen: (c), for all 36 files with commands. The client is `Pick<NodeClient, "invokeRaw">` rather than a `NodeScope`, so a domain client (Phase 7) or a test fake fits it; `scopeBackendClient(scope)` is there for callers that want the scope's prefetched cache.
- **`shared.ts` has no factory.** It holds three pure helpers (`parseTerminalSessionCreateResult`, `isRecord`, `terminalWriteWasDelivered`) and sends nothing, so "every `lib/backend` file" is read as every file with a command: 36 of the 37 source files (plus the new `client.ts`). `factories.test.ts` asserts the 36.
- **Two factories removed (2026-11-13, [7571](../../docs/todo/cross-cutting/7571-removal-candidates-needing-a-decision.md) task 14).** `command-nodes.ts` and `self-improvement.ts` no longer export `createCommandNodesApi` and `createSelfImprovementApi`: no scope ever wired either in, because command-node commands always go to the command node over the portal and self-improvement is the window's own backend. Their named exports are plain functions bound to `portalBackendClient` and `commandBackendClient`, so they are not counted shims either. `factories.test.ts` skips both and asserts the other files.
- **How the conversion was done.** A one-off codemod (oxc-parser, not committed) moved every top-level declaration that reaches a transport (`invoke`, `machineInvoke`, the portal alias in `command-nodes.ts`, or another `lib/backend` file's command functions), and transitively the declarations that use those, into the file's factory in source order; JSDoc directly attached moved with each function, module and section comments stayed in place. Overload signatures move with their implementation (`refreshHostAgentModelCatalog`). The one cross-file use (`graph-runs.ts` on `graph-run-rewind.ts`) is `const { ... } = createGraphRunRewindApi(client)` inside `createGraphRunsApi`, so a graph-runs client's rewind calls go to the same node. Then `bun fmt`. No `lib/backend` file has module-level mutable state, so nothing per-node had to move into the factories.
- **3016's `call = invoke` getters converged.** `getClientStateCapabilities`, `getNativeAgentSyncCapabilities` and `getTranscriptArtifactCapabilities` lost their `call` parameter (now plain factory members). Their callers (`lib/client-state-capabilities.ts`, `lib/native-agent-sync-capabilities.ts`, `hooks/useTranscriptArtifactCapabilities.ts`, outside the file set, minimal edits) use `backendApiForScope(scope, createXApi, { getX }).getX()`. The command-bound function is passed, not built, because 24 suites mock those reads on `@/lib/backend`. `native-agent-sync-capabilities.ts` imports `createWorkflowsApi` from `@/lib/backend/workflows`, not the barrel, because suites replace the barrel with partial mocks. `changes.ts` `getChangeTrackingCapabilities(scope)` now uses `clientInvoke(scopeBackendClient(scope))` instead of `scopeInvoker`. It stays outside `createChangesApi` because its cache lives on the scope. `scopeInvoker` in `lib/node-scope-slots.ts` is now used only by `design-client.ts` (not touched).
- **Test semantics checked.** Bun's `spyOn(namespace, "x")` replaces the module binding, so before this change a spy on `x` also caught a call to `x` from `y` inside the same file. Inside a factory, `y` calls the factory's own `x`. That is a possible test-only difference; the whole web suite (13,626 tests) showed none. Its only failures were 9 from another agent's in-progress `fleet-currency` module.
- **Guard `lib-backend-command-default` (`tests/source-guards/lib-backend-command-default.ts`).** A production-source guard over `apps/web/src`.
  - **Which modules.** Modules that hold per-node state: they define a scoped store, service or slot (`defineScopedStore`, `defineScopedService`, `defineScopedSlot`). That is "converted stores' modules and services", read from the source, so a module enters the guard when its item converts it and no registry has to be kept. `lib/node-scope/**`, `lib/node-scope-slots.ts`, `lib/backend/**`, `src/test/**`, test files and test-support modules are not counted.
  - **What counts.** Each use (call, value, shorthand property, re-export) of a command-bound name, through a named, aliased or namespace import, followed through `@/lib/backend` or any re-export (`export *`, `export { } from`) to the file whose shim binds it. The shim names are read from the `lib/backend` sources: an exported `const` whose initializer is a call taking `commandBackendClient` or `portalBackendClient`. Factories, types, helpers that send nothing, member and key names, type positions (`typeof getX`) and the command-scope fallback handed to `backendApiForScope` are not counted.
  - **Keys.** Per `lib/backend` file and module, `[projects-environments] apps/web/src/stores/x.ts`, like 3001's per-store keys.
  - **Options considered.** (a) Count importers of `@/lib/backend` everywhere: 250 importers with no way to tell scoped code from window code, so the count could not fall as stores convert. (b) A registry of converted modules like `SHIMMED_STORES`: one more list each store item must remember. (c) Modules that define scoped state (chosen): self-maintaining, and exactly the code that has a scope to pass.
  - **Baseline (2026-11-07): 0.** At HEAD the converted modules (`stores/claudeOptionsStore.ts`, `lib/data-saving.ts`, `lib/transport-connectivity.ts`, `lib/read-coordinator.ts`, `lib/client-state-capabilities.ts`, `lib/native-agent-sync-capabilities.ts`, `hooks/useTranscriptArtifactCapabilities.ts`, `lib/design-client.ts`) have no command-bound use. The entry was written with `bun tests/source-guards/update-baseline.ts --guard lib-backend-command-default`, then the findings of other agents' uncommitted conversions were removed, so the committed baseline matches committed sources: `"lib-backend-command-default": {}`. Every other guard's entries are unchanged.
  - **The shim itself: 647 command-bound names** in 36 files (646 destructured from the factories, plus `machineInvoke`). They fall only as callers move to factories and Phase 7 replaces bodies with domain clients; the guard counts their uses in converted code, not the names.
- **Open for the orchestrator: in-progress conversions will meet the guard.** In this wave's working tree, other agents' uncommitted modules already define scoped services and use command-bound names: `lib/store-resource-sync.ts` (`[projects-environments]` 2, `[agent-mail]` 1, `[files-sessions]` 1), `lib/scope-services.ts` (`[projects-environments]` 3) and `lib/pane-layout-persistence.ts` (`[files-sessions]` 6). When each is committed, its item should move those calls onto `createXApi(scopeBackendClient(scope))` or regenerate with `--guard lib-backend-command-default` and record why.
- **File sizes.** `workflows.ts` is 1,953 lines (it was 1,705): each of its 118 names is listed twice, in the factory's `return` and in the shim. It is under 2,000, but with little room. Splitting it by domain (native agent, build pipelines, multi-review) is a natural Phase 7 step. Every other file is under 1,100.
- **Where Effect is used, and where not.** Not used. The factories are plain closures over a synchronous `invokeRaw`. `backendApiForScope`'s per-scope memo is a `WeakMap`, which dies with the scope without a finaliser. A `Context`/`Layer` per domain is what Phase 7's typed domain clients bring, and the factory shape is chosen so they can replace the bodies one file at a time.
- **Aggregate suite left to review preparation.** `mise run test` was not run.
- **For the report.** §7.4's figures at conversion: 37 source files (36 with commands), 647 command-bound names, ~11.3k lines including the factories. *(2026-11-07, orchestrator, completeness check: at HEAD `apps/web/src/lib/backend/` has 38 `createXApi` factories, one per file with commands, after later items added files. The `lib-backend-command-default` baseline has one entry, `[projects-environments] apps/web/src/lib/scope-services.ts: 3`: [3014](3014-scoped-services-and-startup.md)'s deliberate manifest reads on the app command scope, which suites mock; any other scope sends the same commands through its own client.)*

## Work log

- 2026-11-07 (claude-worker): added `lib/backend/client.ts` (`BackendClient`, `commandBackendClient`, `portalBackendClient`, `clientInvoke`, `scopeBackendClient`, `backendApiForScope`, `machineInvoker`). Converted all 36 `lib/backend` files with commands to `createXApi(client)` plus a command-bound shim (codemod, then `bun fmt`). Converged 3016's three `call = invoke` getters and their callers on `backendApiForScope`, and `changes.ts` on `scopeBackendClient`. Updated the `backend.test.ts` arity sweep to skip factories. Added the `lib-backend-command-default` source guard, its tests and an empty baseline entry. Updated `docs/development/node-scopes.md` and `docs/development/linting.md`. Tests: new `lib/backend/factories.test.ts` (37: one per factory proving the given client is used and the command scope is not, plus the file count) and `lib/backend/client.test.ts` (5). `src/lib/backend` plus `backend.test.ts` pass (183). Focused `src/lib src/hooks src/stores src/components/{chat,changes,native-agent}` passes. The whole web suite had 13,626 pass and 9 fail, all from another agent's missing `@/lib/federation/fleet-currency`. `tests/unit/source-guards.test.ts`: 49 pass. The 1 failure is the repository ratchet, on the pre-existing test-guard findings and the uncommitted modules listed in Notes. Web typecheck, oxlint and fmt are clean.
- 2026-11-07 (orchestrator, completeness check): recorded the current factory count (38) and that the one `lib-backend-command-default` baseline entry, `scope-services.ts: 3`, is 3014's deliberate command-scope manifest reads.
