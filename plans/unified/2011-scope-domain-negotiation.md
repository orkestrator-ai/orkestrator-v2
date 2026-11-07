---
id: 2011
title: "Negotiated domains and typed invoke on every NodeClient"
phase: 2
plan: "§6.1 domains and §11.2 Negotiation"
status: done
depends_on: [2010, 1009]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 2011 · Negotiated domains and typed invoke on every NodeClient

- **Report:** [§6.1](../../docs/reports/unified-federation.md#61-the-nodeclient-contract), [§11.2](../../docs/reports/unified-federation.md#112-design)
- **Depends on:** [2010](2010-command-scope-wiring.md), [1009](1009-domain-clients-and-adapters.md). **This is where the two tracks join.**
- **Blocks:** web-side work in Phase 7, [5006](5006-fleet-currency.md)
- **Size:** S
- **Track:** S and C (join)

## Goal

`scope.client.domains` holds the hello's negotiated ranges for the current connection generation. `scope.domain(client)` returns a version-adapted domain client, and `client.invoke(def, args)` is typed.

## Work

- [x] Read the hello once per connection generation for each node client (browser: the probe already fetches it; desktop: main includes the parsed `domains` in `orkestrator:nodes:gateway`). Expose `domains: ReadableSignal<NegotiatedDomains | null>`, where `null` means pre-contract.
- [x] `NodeClient.invoke(def, args)` sends the envelope (`domain`, `version`, `critical`) and returns `ResultOf<C>`. `invokeRaw` stays for migration.
- [x] `scope.domain(def)`: `createDomainClient` over the scope client, cached per `domains` value and rebuilt on a new generation.
- [x] The command scope reads its own hello too (the renderer currently never parses the hello for the command node).

## Tests

- [x] A generation change (reconnect to an upgraded backend) rebuilds domain clients; a pre-contract node gets version-0 adapters.

## Done when

- [x] A scoped component can call `scope.domain(nodeMail)` (the pilot) against both a current and a pre-contract fake node.

## Notes

### API (2026-11-07)

- **`packages/protocol/src/node-client.ts`.** `NodeClient` gained `invoke<C extends AnyCommandDef>(def: C, args: ArgsOf<C>): Promise<ResultOf<C>>`, `capabilities: ReadableSignal<ReadonlySet<string> | null>`, and `invokeRaw(command, args?, options?: NodeInvokeOptions)` with `NodeInvokeOptions { envelope?: ContractEnvelopeFields }`. `domains` keeps its type; its doc now says a new object appears exactly when a new generation's hello was read. `nodeId` may change only for the command client (provisional to proven).
- **`apps/web/src/lib/node-scope/negotiation.ts`.** `createHelloNegotiation(source): HelloNegotiation` with `domains`, `capabilities`, `installationId` signals, `refresh()` (one read at a time, one queued) and `ensure()` (read until an answer), `dispose()`; `helloFrom(value)`. A source answers a hello, `null` (no hello: pre-contract) or `undefined` (unknown: no change), or throws (no change). Values change only when `installationId` + `generation` differ; `domains` is a frozen copy, so each generation is a new object.
- **`typed-invoke.ts`.** `typedInvoke(rawInvoke): NodeClient["invoke"]` (envelope from 1009's `contractEnvelopeFields` at `def.domain.version`, result decoded with 1002's `decodeCommandResult`, `InvalidCommandResultError` thrown) and `nodeDomainCall(client): DomainCall` (the domain client's transport over `invokeRaw(…, { envelope })`; adapter 0 sends none). Every client and `FakeNodeClient` build `invoke` with it, like 7011's `typedListen`.
- **Clients.** Browser: hello through `NodeTransport.hello()` at creation and after every reconnect from a drop. Desktop: from `nodes.gateway(nodeId)`'s new `hello` field (`snapshotHello(snapshot)`) on the stream's first open and after every drop. Command (`createWindowOrkestratorClient` now returns `WindowOrkestratorClient` with `provenNodeId`): `window.orkestrator.hello()` (browser gateway, local desktop direct gateway) or, in an Electron IPC window with a proven id, `nodes.gateway(commandNodeId)`; re-read after the gateway stream reconnects, or on `desktop-connections-changed` in Electron. The leaf registry (2004) mirrors `capabilities` next to `domains` across a route change and forwards `invoke`/`invokeRaw` options.
- **`NodeScope.domain(def): DomainClient<ApiOf<D>>`.** Memoised per definition per scope; `createDomainClient(def, { call: nodeDomainCall(client), domains: () => client.domains.get(), capabilities: () => client.capabilities.get(), invoke, usage })` with `usage` = `recordDomainAdapterUsage` (1009's renderer ring; `WindowScopeOptions.domainUsage` / `NodeScopeInit.domainUsage` override it for tests). Dropped with the scope (a `domains` finalizer on its lifetime); refused once disposed.
- **Proven command id.** `WindowScope.adoptCommandNodeId(nodeId): boolean`, `NodeScope.adoptNodeId` (WindowScope only), `ByteBudget.renameNode` / `renameNodeInBudgets`. `app-window-scope.ts` subscribes to the command client's `provenNodeId` and adopts.
- **Transport (outside the file set, minimal).** `lib/native/node-transport.ts`: `invoke(command, args?, options?: NodeTransportInvokeOptions)` adds only `domain`, `version`, `critical` from `options.envelope` to the body (terminal input the sequencer orders goes without one; those commands are untyped); `hello(): Promise<BackendHello | null>` (10 s timeout, 64 KiB bound, 404 or a non-hello 200 is `null`, other non-OK statuses and network errors throw). `lib/native/web-gateway.ts` exposes `hello` on the browser gateway API and the local desktop gateway. `vite-env.d.ts`: `orkestrator.hello?()`.
- **Desktop main (outside the file set, minimal).** `apps/desktop/electron/scope-hello.ts` `readNodeHelloAt(baseUrl, token, { timeoutMs, fetchImpl? })` (appends the path to the base, so a relayed workspace answers its own hello; `checkBackendRoute` resolves against the origin and would read the command node's). `ConnectionManager.scopeHello(scope)`: the local backend's hello, a saved machine's last hello, or a workspace connection's own, cached per connection epoch (a `WeakMap` per `RemoteConnection`; a failed read is not kept). `DesktopNodeIpc.gateway` is now async and adds `hello` to both snapshot branches when the manager has `scopeHello` (absent when the read fails, so the renderer keeps its values).

### Decisions (2026-11-07)

- **What a "connection generation" is.** The hello's own `installationId` + `generation` (the backend process). Options: (a) a client-local counter bumped on every reconnect, (b) the hello's identity. (a) would rebuild every domain client on every network blip; (b) rebuilds exactly when the backend changed. Chosen (b). The hello is still *read* on each reconnect after a drop (that is when a restart or upgrade can show), but publishing is deduplicated. For a node with no hello the objects never change, so `scope.domain` additionally `reset()`s its clients when the connection goes back to `live`, which drops a legacy adapter's cached capability answers across a restart.
- **Where the browser reads the hello.** The item said "the probe already fetches it". The probe in `openLeafWorkspace` runs only for direct origins and only at grant open; a relayed leaf, a reconnect and the command node have none. So the client reads it through its own transport (one extra `GET /__orkestrator/hello`, `no-store`, per generation), which the relay already forwards. The probe stays a reachability check.
- **Desktop: main reads it.** The renderer never holds a node scope's credential, so main reads the hello (per connection epoch) and puts the parsed `BackendHello` (non-secret; any authenticated client may read it) in the `orkestrator:nodes:gateway` snapshot, as the item said. The renderer re-validates it with `parseBackendHello`. A workspace connection had no hello in main before; the saved-machine and local paths reuse the hellos main already keeps.
- **`invoke` sends this build's version.** `client.invoke(def, args)` always sends `def.domain.version` (1002's `buildInvokeEnvelope` default); a node outside that range answers the typed `unsupported-version`. Version adaptation is the domain client's job (`scope.domain`), which sends the *picked* version through `invokeRaw(…, { envelope })`. A local pre-check against `domains` was rejected: before the hello is read `domains` is `null`, and refusing then would fail calls a current node accepts. A pre-contract backend ignores the envelope fields (tolerant reader), so they are always sent.
- **Envelope transport.** `invokeRaw` gained an `options.envelope` rather than a new member, so every call site and fake keeps its two-argument shape (and an untyped call is still sent with two arguments, which existing `toHaveBeenCalledWith` assertions rely on). Over IPC the envelope is the invoke options (1003); over HTTP its three fields join the body. `args` is never in the envelope.
- **`capabilities` on `NodeClient`.** 1009's legacy adapters (node-mail's version 0) gate on the hello's capabilities, so a scope needs them next to `domains`. A separate signal (`ReadonlySet<string> | null`, names at version 1 and up) rather than a combined hello signal keeps `domains` exactly as 2001 typed it. Both change together, capabilities first.
- **Proven command id on hosted pages.** Options: (a) await the hello before the window scope is created (an extra boot round trip, and `startApp`'s catalogue read already creates the scope through `invoke`, in another item's file); (b) re-key the command scope when the hello answers; (c) keep the provisional id. Chosen (b) with safeguards 2010 lacked: the provisional id stays an alias (`WindowScope.get` still finds the scope, so a value captured before the hello, a dialog request, say, still resolves), the registry keeps its order, byte-budget reservations are renamed in recency order (and both ids are released on dispose), and the selection follows. Only a provisional command scope moves, only to a proven id no other scope holds, once. Known limits: a component keyed by `scope.nodeId` remounts once if it was open in that first moment (`AppDialogHost` keys by node), and a rich-content cache entry stored under the provisional id misses once and is refetched. Desktop windows and realm documents already open under a proven id and never move.
- **Electron IPC command node.** It is read from `nodes.gateway(commandNodeId)` only when the window's id is proven (main's `isCommandNode` matches proven ids); a provisional Electron window stays `null` (legacy adapters), which is today's behaviour.

### Where Effect is used, and where not (2026-11-07)

- **Used:** the domain clients' lifetime is the node scope's Effect `Scope` (the `domains` finalizer stops the generation watch and drops them, in the scope's reverse-order close); `effect/Result` for the result decode in `typedInvoke`, as 1009's domain client does; 1005's `Data.TaggedError`s reach callers unchanged.
- **Not used:** the hello read is a promise with an `AbortController` timeout, not `Effect.timeout`/`Schedule`: it is not retried on a schedule at all (the next reconnect is the retry, which the transport's own `ReconnectBackoff` and main already pace), and it feeds a synchronous signal React reads with `useSyncExternalStore`, so an Effect runtime would sit between a callback and a `set` for no gain. The negotiation is a few lines of closure state rather than a `SubscriptionRef` for the same reason. `createDomainClient` stays promise-based (1009's decision).

### Other

- Tests: `negotiation.test.ts` (13: the negotiation rules, browser, desktop and command clients, typed invoke over HTTP and IPC), `scope-domain.test.tsx` (8: memoised and rebuilt on a new generation, version 0 for a pre-contract node with usage counted, reset on reconnect, `unsupported-version`, dispose, `adoptCommandNodeId`, and the Done-when pair), a hosted-page adoption test in `window-scope.test.ts`, three `node-transport.test.ts` tests (envelope body, relayed hello, bearer), desktop `scope-hello.test.ts` (2), a `node-ipc.test.ts` snapshot test and a `connection-manager-federation.test.ts` per-epoch test. Two existing expectations changed: `node-clients.test.ts` "two leaves" now sees each client's hello read on its own grant, and `command-client.test.ts` counts the client's own reconnect watch.
- `FakeNodeClient` (`src/test/render-in-node-scope.tsx`) gained `invoke`, `capabilities`, a `capabilities` option, `setHello({ domains, capabilities })` (a new generation) and `envelope` on recorded invocations.
- Not run here: a live run against real backends of two versions (left to the final live qualification pass). Aggregate suite left to review preparation. The full web suite was run once: 13,817 pass; the 2 `AppDialogHost.test.tsx` failures come from another agent's uncommitted `AppDialogHost.tsx`/scoped `environmentStore` work (the dialog's environment lookup now reads node B's empty store), and the 1 error was a test file deleted mid-run.
- For the report: §6.1's sketch should list `capabilities`, and `invokeRaw(command, args, options?)` with the envelope option; §11.2 "Negotiation" could name the generation key (`installationId` + `generation`).

## Work log

- 2026-11-07 (claude-worker): typed `invoke`, `capabilities` and the `invokeRaw` envelope option on `NodeClient`; `negotiation.ts` and `typed-invoke.ts`; hello reads in the browser, desktop and command clients and through the leaf registry; `scope.domain(def)`; proven-id adoption for a provisional command scope (`adoptCommandNodeId`, budget rename, alias); `NodeTransport.hello()` and the envelope body; desktop main's `scopeHello`, `readNodeHelloAt` and the `hello` in `orkestrator:nodes:gateway`; `FakeNodeClient` updates; docs (`version-compatibility.md`, "Hello `domains`" and "Client adapters"). Tests: web node-scope, native, portal, federation and usage-ring suites 822 pass; desktop node-ipc, scope-hello, connection-manager-federation, node-previews, preload-api, node-scopes 114 pass. Typecheck clean for protocol and desktop; web clean in these files (one error in another agent's `project-environment-resource-handlers.test.ts`). fmt and oxlint clean on the touched files; no source-guard findings in them.

