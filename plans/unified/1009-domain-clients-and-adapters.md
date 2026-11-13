---
id: 1009
title: "Domain clients, version adapters and legacy adapters"
phase: 1
plan: "§11.2 Client adapters and §11.4"
status: done
depends_on: [1002, 1004]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 1009 · Domain clients, version adapters and legacy adapters

- **Report:** [§11.2 Client adapters](../../docs/reports/unified-federation.md#112-design), [§11.4 Transition](../../docs/reports/unified-federation.md#114-transition-pre-contract-nodes)
- **Decisions:** 13.6 (both sides adapt), 13.9 (per domain)
- **Depends on:** [1002](1002-contract-primitives.md), [1004](1004-hello-domains.md)
- **Blocks:** [1008](1008-contract-ci-job.md), [1010](1010-pilot-node-mail-and-ticket-sync.md), [2011](2011-scope-domain-negotiation.md)
- **Size:** M
- **Track:** C (contract)

## Goal

Callers use `domainClient(...).method(...)` and never see a version. The highest version both sides support is chosen once per connection generation. A node without `domains` uses a version-0 legacy adapter that packages today's capability gating.

## Work

- [x] `packages/protocol/src/contract/client.ts` (shape from [1002](1002-contract-primitives.md)):
  - `createDomainClient(def, { call, domains })`, where `call(def, args, envelope)` is the transport and `domains` is the negotiated map or `null` for pre-contract nodes;
  - it selects the adapter with `pickVersion`, caches the choice per `domains` identity, and throws a coded `unsupported-version` when there is no overlap.
- [x] The version-0 rule: a pre-contract node always uses adapter `0`. Each domain's adapter 0 may consult the existing per-domain capability command (the 8 `*_capabilities` commands) or the hello `capabilities`.
- [x] An adapter registry that lists (domain, version) pairs for the CI job ([1008](1008-contract-ci-job.md)). Write `packages/protocol/contracts/adapters.json`, with a check mode.
- [x] Content-free usage counters per (domain, adapter version):
  - backend side: the existing compatibility-path counters;
  - renderer side: a new bounded counter ring next to `renderer-error-ring.ts`, uploaded with the existing client metrics.
- [x] Retirement rule in code comments and docs: adapter `v` is deleted when the floor passes the first Stable release with `v + 1`.

## Tests

- [x] Selection across ranges; pre-contract selects 0; no overlap gives a coded error; the cache is invalidated when `domains` changes (a new connection generation).
- [x] Counters are bounded and contain names and numbers only.

## Done when

- [x] A test domain with versions 0, 1 and 2 works against fake backends advertising each range.

## Notes

- The per-domain capability commands that exist today: `design_capabilities`, `web_annotations_capabilities`, `get_preview_capabilities`, `changes_get_capabilities`, `transcript_artifact_capabilities`, `get_native_agent_sync_capabilities`, `get_agent_handoff_capabilities`, `get_client_state_capabilities`. That is 8, not "about ten". Each is folded into its domain version during Phase 7.

### Where Effect is used (2026-11-07)

- **Effect Schema** for the one new wire contract: `recordDomainAdapterUsageCommand` (`record_domain_adapter_usage`, `system` domain) and its `DomainAdapterUsageEntrySchema`, reusing 1002's `DomainNameSchema`/`DomainVersionSchema`.
- **`effect/Result`** from 1002's `decodeCommandResult`: a domain client decodes every result with the command's schema and throws the `InvalidCommandResultError` (`Data.TaggedError`) on a mismatch. The no-overlap refusal is 1002's `UnsupportedVersionError` (`unsupportedVersion`), so `incompatibility(error)` reads it like a node's own answer.
- **Deliberately not Effect:** `createDomainClient` is promise-based. Selection is a synchronous cache lookup and every method is the adapter's own promise; wrapping each call in an `Effect` would add a runtime on every call for typed errors the callers (promise-based node scopes, the node link) would immediately unwrap. The ring, the uploader and the adapter list are plain classes/functions; no services, scopes or fibers are needed. The uploader's backoff is a hand-rolled timer like `renderer-error-upload.ts` rather than `Schedule`, because it must stay idle (no timer) while there is nothing to send and must be driven by an injected fake timer in tests.

### Decisions (2026-11-07)

- **API shape.** `createDomainClient(def, { call, domains, capabilities?, invoke?, usage? })` returns `{ def, version(), api(), reset() }` rather than the API object itself: the API cannot be built before a version is picked, and a node scope (2011) calls `api()` per use, which is one identity comparison once cached. `domains` (and `capabilities`) may be a value or a getter, so a `NodeClient`'s `domains.get()` plugs in directly. The cache is one slot keyed on the identity of both: a new hello gives new objects, so a new connection generation re-picks; `reset()` covers a transport that reconnects with the same objects (a legacy node with no hello). The no-overlap result is cached too and `api()` throws a fresh `UnsupportedVersionError` naming the node's range (`{ min: 0, max: 0 }` for a pre-contract node), with the client's highest version in the message.
- **Transport `call(def, args, envelope)`.** `envelope` is `ContractEnvelopeFields` (`{ domain, version, critical? }`), never `args`, following 1003's IPC recommendation (4096-character bound), and assignable to the node link's `ContractEnvelope`. The version is the **picked** version, not the definition's own (`contractEnvelopeFor` in `node-link.ts` sends `def.domain.version`; 1010 should send through a domain client or pass the picked version). Adapter 0 sends **no** envelope, so a pre-contract node, or a contract node without the domain, gets today's `{ command, args }`.
- **Adapter guards.** An adapter's `call` refuses a command from another domain (its envelope would carry the wrong domain's version) and, from version 1 up, a command whose `since` is above the adapter's version. Version 0 is exempt: legacy nodes have the commands without a contract version.
- **Legacy context (version 0 rule).** `DomainAdapter<Api>` gained a second parameter, `DomainAdapterContext` (`domain`, `version`, `range`, `capabilities`, `invoke`, `capability`), which keeps 1002's one-parameter adapters assignable. `LEGACY_CAPABILITY_COMMANDS` lists the 8 commands under their domains from `contract-domain-map.ts` (`native-sessions` has two; a backend test pins the mapping). `capability(command)` only accepts the domain's own commands, reads once per generation, answers `null` for `unknown-command` (via `incompatibility(error, command)`, so the legacy text counts too), and does not keep any other failure, matching today's "never read a transient error as legacy" rule (`getAgentHandoffCapabilities`).
- **Adapter list.** `DOMAIN_CLIENTS` (`contract/client-adapters.ts`) is a static list, not a side-effect registry, so the generator and CI import it without running anything. One client per domain (`buildAdapterList` throws on two), so "an adapter exists for (domain, version)" has one answer for 1008. Clients live in `packages/protocol/src/contract/domains/`; a test scans `packages/*/src`, `apps/*/src` and `apps/desktop/electron` for `domainClient(` and requires each defining module to be there and each exported client to be in `DOMAIN_CLIENTS`. This deviates from the report's sketch (§11.2 shows the web client under `apps/web/src/lib/node-scope/domains/`): protocol is where the backend pilot (1010) can use it too and the one place CI can enumerate. `adapters.json` is `{ schemaVersion, generatedBy, retirement, domains: { <name>: { current, adapters } } }`, written by `scripts/generate-contract-adapters.ts` (`mise run contract:adapters`, `contract:adapters:check`, a new CI step after `contract:check` in `ci.yml`'s Lint job). For 1008: `parseAdapterList`, `hasDomainAdapter(list, domain, version)`; a release without `domains` is version 0 for every domain. It is empty today (no domain client yet). *(2026-11-07, orchestrator, completeness check: stale: `adapters.json` now lists 28 of the manifest's 29 domains, each with its current version and a version-0 adapter; the one without a client is `public-api`, deliberately (7009 Notes, "No `public-api` domain client": every caller calls `public_action` by name).)*
- **What is counted.** Each call through an adapter **below** its domain's current version (including 0), not the current one: those are the compatibility paths whose retirement needs evidence, and a fleet that is current then uploads nothing. Per call, not per selection, like `compatibilityPathUsage.record`. A recorder that throws is swallowed.
- **Backend counters.** The existing compatibility-path counters, with dynamic ids `domain-adapter.<backend|renderer>.<domain>.v<version>` (`DomainAdapterPathId`, a template type added to `CompatibilityPathId`; snapshots keep only well-formed ids naming a known domain). `CompatibilityPathUsage.record(id, count = 1)` gained the count for uploads. Not added to `COMPATIBILITY_PATH_IDS`: the ids follow the adapter list, and listing each would duplicate it. `backendDomainAdapterUsage` (`apps/backend/src/core/domain-adapter-usage.ts`) is the recorder for the backend's own clients (1010).
- **Renderer upload.** A new command, because `record_renderer_errors` rejects unknown keys (an older backend would refuse the whole error batch) and `/client-metrics` is a one-shot boot report on the HTTP gateway only. 1011's ratchet requires new commands to be defined, so `record_domain_adapter_usage` is the first `defineCommand` in the real registry: `system` domain v1 (the hello now advertises `system: { min: 1, max: 1 }`), `access: "admin"`, refused to workspace clients (`WORKSPACE_ADMINISTRATION_COMMANDS`). Its arguments are tolerant (unknown keys dropped); the backend counts only pairs in this build's adapter list below current (`countedAdapterKeys`) and answers `{ accepted, dropped }`, which bounds the id set by the code. The renderer ring (`DomainAdapterUsageRing` in protocol, instance in `apps/web/src/lib/domain-adapter-usage-ring.ts`: 64 pairs, counts capped at 1,000,000, batches of 32) uploads at most once a minute and only while it has counts, backs off to 10 minutes, and stops on `unknown-command`. It starts with the renderer error upload (`renderer-diagnostics.ts`, the desktop window's own renderer); browser tabs and realms do not upload. (Since to-do 6300 (retired 2026-11-13; `git show 17d28238c:docs/todo/cross-cutting/6300-renderer-error-ring-for-realms-and-web-clients.md`) task 2, 2026-11-11, a browser tab does send its error ring, but not these counts.) In memory only (no session-storage journal like the error ring): a reload loses at most one interval of counts.
- **The `system` domain definition** is imported from `packages/protocol/src/contract/domains/system/domain.ts`, created by 7011; it was still untracked, so this item committed that one file unchanged.
- **Test adjustment outside the set:** `commands-registry-contracts.test.ts`'s "the real registry has no definitions yet" now asserts the registry's definitions and ranges equal the committed manifest's (`counts.defined`, `domains`), which stays true as domains convert.
- **No contract log events:** nothing in this item has a failure worth an essential-log line (the refusal reaches the caller as a coded error; drops are answered in `dropped`).
- **Wiring left to other items:** 2011 passes `recordDomainAdapterUsage` as `usage` and the node client's `domains`/hello `capabilities` when it builds `scope.domain(...)`; 1010 passes `backendDomainAdapterUsage` and adds its clients to `DOMAIN_CLIENTS` (then `mise run contract:adapters`).
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): `createDomainClient`, `DomainAdapterContext`, `LEGACY_CAPABILITY_COMMANDS`, `contractEnvelopeFields`, `isDomainClientDef` (`contract/client.ts`); `contract/client-usage.ts` (`DomainAdapterUsageRing`, `recordDomainAdapterUsageCommand`, `domainAdapterPathId`, bounds); `contract/client-adapters.ts` (`DOMAIN_CLIENTS`, `buildAdapterList`, `serializeAdapterList`, `parseAdapterList`, `hasDomainAdapter`, `countedAdapterKeys`, `describeAdapterListDrift`); `packages/protocol/contracts/adapters.json`, `scripts/generate-contract-adapters.ts`, mise tasks and the CI step. Backend: domain adapter ids in `compatibility-path-usage.ts`, `domain-adapter-usage.ts`, the `record_domain_adapter_usage` command, the workspace-grant refusal, manifest regenerated (997 commands, 1 defined). Web: `domain-adapter-usage-ring.ts` and its start in `renderer-diagnostics.ts`. Docs: `version-compatibility.md` "Client adapters". Tests: protocol `client.test.ts`, `client-create.test.ts` (incl. the Done-when matrix), `client-usage.test.ts`, `client-adapters.test.ts`; backend `domain-adapter-usage.test.ts`; web `domain-adapter-usage-ring.test.ts`, `renderer-diagnostics.test.ts`.
- 2026-11-07 (orchestrator, completeness check): marked the "adapters.json is empty" note stale: it lists 28 of 29 domains, `public-api` deliberately without a client (7009).
