---
id: 7010
title: "Converge backend and web models on protocol schemas"
phase: 7
plan: "§11.2 Definitions and §11.1"
status: in-progress
depends_on: [7003, 7005]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 7010 · Converge backend and web models on protocol schemas

- **Report:** [§11.1](../../docs/reports/unified-federation.md#111-where-skew-actually-is), [§11.2](../../docs/reports/unified-federation.md#112-design)
- **Depends on:** [7003](7003-domain-environments-docker.md), [7005](7005-domain-projects-config.md) (they define the core `Environment` and `Project` schemas)
- **Parallel with:** the remaining Phase 7 items, each of which moves its own types
- **Size:** M (rolling)
- **Track:** C (contract)

## Goal

One definition of each core model. `apps/backend/src/core/models.ts` (1,334 lines) and `apps/web/src/types/index.ts` (771 lines, which "mirrors the backend model") shrink to re-exports of inferred protocol types, plus genuinely local types.

## Work

- [x] For each type in both files, record its owner domain and status (moved / local-only / pending) in a table in Notes. Update the table as each domain item lands.
- [ ] Replace the duplicated types with the inferred types of the protocol's Effect Schemas (`typeof X.Type`, or `Schema.Schema.Type<typeof X>`; Decision 13.8 changed from Zod to Effect on 2026-11-07). Where the web needs a narrower or derived view type, derive it from the protocol type.
  - [x] The environment, settings, project, terminal session, pane layout, draft and handoff models, and the vocabularies they use (see the table).
  - [ ] The rest (the table's "pending" rows): agent-server catalogues (7009), Multi Review and build pipeline records on the web (7007), Cursor SDK sign-in (7008), and the native agent session and prompt queue records, whose `native-sessions` schemas are still tolerant readers (follow-up here).
- [x] A test that fails if a type exported from both `models.ts` and `types/index.ts` under the same name is not the same protocol type. (`tests/unit/model-type-convergence.test.ts`, see Notes.)

## Done when

- [ ] Neither file defines a wire model that protocol also defines. Open: the "pending" rows of the table.

## Notes

### Owner-domain table (2026-11-07)

"Moved": the file re-exports the protocol type (or aliases it). "Derived": the file declares a view built from the protocol type (the plan's "narrower or derived view type"). "Local-only": not a wire model. "Pending": a protocol schema exists but is not yet the model's definition, with the reason and owner.

**Both files** (the names the convergence test compares):

| Type | Owner domain | Status | Notes |
| --- | --- | --- | --- |
| `Project` | projects | moved (7005) | |
| `EnvironmentStatus`, `PrState`, `NetworkAccessMode`, `EnvironmentType`, `EnvironmentLifecycleOperation`, `PortProtocol`, `EnvironmentUnreadReason` | environments | moved (7003) | backend also `EnvironmentSetupPhase` |
| `AgentActivityState` | protocol `agent-activity` | moved | the protocol's own vocabulary |
| `PortMapping`, `InitialPromptImageAttachment` | environments | moved (7010) | |
| `RepositoryConfig` | config | moved (7010) | web `LastEnvironmentAgentSelection` derived from it |
| `DefaultAgent` | protocol `agent-platforms` | moved (7010) | alias of `AgentPlatform` |
| `AgentStyle`, `ClaudeMode`, `CodexMode`, `OpenCodeMode`, `ClaudeNativeBackend` | config | moved (7010) | `AgentLaunchMode`/`ClaudeNativeBackend` of `config/agent-settings.ts` |
| `Session`, `SessionType`, `SessionStatus`, `PersistedFileDraft`, `PersistedPaneLayout` | native-sessions | moved (7010) | the web's `PersistedPaneLayout` is in `types/paneLayout.ts` |
| `PersistedComposeDraft`, `PersistedAgentHandoff` | native-sessions | moved (backend) / derived (web) | the web's are generic over `value`/`snapshot` |
| `Environment` | environments | homonym | backend: the stored record (backend-private); web: `ClientEnvironment` without `containerLifecycle`, plus `initialPromptAttachments` (derived) |
| `AppConfig` | config | homonym | backend: `StoredAppConfig` (credentials); web: the protocol `AppConfig` with the redacted fields and the Codex thread limit optional (derived) |
| `ClaudeModelCatalogEntry`, `ClaudeModelCatalogSnapshot` | agent-servers | pending (7009) | the schemas read `source`/`supportedEffortLevels` as strings |
| `PersistedBuildPipeline` | pipelines | moved (backend, 7007) / pending (web, 7007) | the web's is generic over `snapshot` |
| `PersistedNativeAgentSession`, `PersistedPromptQueue` | native-sessions | pending (7010 follow-up) | 7001's schemas are tolerant readers (every field optional, providers as strings); the web's are narrower views |

**Backend only** (`models.ts`):

| Type | Owner domain | Status |
| --- | --- | --- |
| `ClientEnvironment`, `StartupAgentSessionSnapshot`, `WorktreeMoveRecord`, `WorktreeMoveSubmodule` | environments | moved (7010) |
| `AgentActivitySource`, `AgentActivitySourceSnapshot`, `FrontendAgentActivityObserverSnapshot` | protocol `agent-activity` | moved |
| `PersistedAgentInteractionResolutionJournal`, `PersistedAgentInteractionWorkflowSummary` | protocol `agent-interactions` | moved (aliases) |
| `ClaudeEffortLevel`, `CodexReasoningEffort`, `CodexModelCatalogEntry`, `PersistedAgentModelCatalog`, `AgentModelCatalogCache`, `OpenCodeModelCatalogEntry`, `OpenCodeModelCatalogSnapshot` | agent-servers | pending (7009) |
| `PersistedMultiReviewWorkflow` | multi-review | pending (7007) |
| `PersistedNativeAgentPendingDispatch`, `PersistedNativeAgentSignInResend`, `PersistedNativeAgentPendingSteer`, `PersistedNativeAgentRetiredDispatch`, `PersistedNativeAgentTurnOutcome`, `NativeAgentSessionBackendTitle`, `IncompleteTurnNotice`, `NativeAgentJobReceipt`, `NativeAgentProvider` | native-sessions | pending, with `PersistedNativeAgentSession`/`PersistedPromptQueue` (parts of those records) |
| `Environment`, `AgentActivityCompletionOutcome`, `NativeAgentJobCompletionAction` | environments / native-sessions | local-only (the stored record; backend activity and job bookkeeping) |

**Web only** (`types/index.ts` and its re-exports):

| Type | Owner domain | Status |
| --- | --- | --- |
| `DomainTestResult` | native-sessions | moved (7010; `DomainResolution`; the backend never answers `resolvable: null`) |
| `EnvironmentSetupSession` | environments | moved (7010; `EnvironmentSetupSessionSnapshot`) |
| `StartEnvironmentResult`, `EnsureEnvironmentSetupResult` | environments | derived (7010; from `EnvironmentSetupStartResult`) |
| `GlobalConfig`, `ContainerResources`, `TerminalAppearance`, `PreferredEditor`, `LastEnvironmentAgentSelection` | config | derived (7010) |
| `GatewayTokenSettings`, `WebClientStatus` | protocol `web-client` | moved |
| `ClaudeCatalogEffortLevel`, `CodexReasoningEffortPreference` | agent-servers | pending (7009) |
| `CursorSdkAuthStatus`, `CursorSdkLoginProgress` | accounts | pending (7008: the schemas read `source`/`state` as strings) |
| `PersistedWorkflowRecord` | multi-review | pending (7007) |
| `UIState`, `FileMention`, `FileCandidate`, the pane layout tree (`types/paneLayout.ts` apart from `PersistedPaneLayout`) | renderer | local-only |

### Decisions (2026-11-07)

- **Model types are the schemas' types made mutable.** Effect's struct types are `readonly`; the models were mutable and the backend and the renderer write them (storage migrations, store updates). Each protocol module exports the model type as `Mutable<typeof X.Type>` (flat records) or `DeepMutable<…>` (records with nested records or lists), as 7005 did for `Project`. Not `DeepMutable` where a field is `unknown` (it maps `unknown` to `{}`): the drafts and the handoff use `Mutable`.
- **Homonyms are named, not renamed.** `Environment` and `AppConfig` mean different records on the two sides (stored vs sent). Options: rename one side (hundreds of files on either side) or keep the names and document the pair. Kept, in the test's `HOMONYMS` list with each side's meaning; both sides are now protocol types or views of them except the backend's stored `Environment`, which is backend-private (its wire forms are `ClientEnvironment` and `EnvironmentDetail`).
- **The web's `Environment` drops `containerLifecycle`.** A list answers the lifecycle snapshot there and `get_environment` the durable record (`EnvironmentDetailSchema` types it as an object), so a single field type would be wrong for one of them; the renderer never read it and reads the snapshot through `get_container_lifecycle_snapshot`.
- **The web's `GlobalConfig` is derived, not the protocol's.** The protocol's `GlobalConfig` (the renderer view 7005 defined) requires the redacted credentials' `*Configured`/`*Source` and `codexMaxConcurrentThreads`; the web declared them optional and its settings drafts and fixtures omit them. Chosen: `Omit<GlobalConfig, those> & Partial<Pick<…>>`, so every other field is the protocol's.
- **`AgentSettingsTierSchema` replaces 7003's placeholder.** The environment model's `agentSettings` was `ownedObject<AgentSettingsTier>()` (any object). The tier, the platform literals and the launch-mode literals moved to `contract/domains/config/agent-settings.ts`, which both `environments/models.ts` and `config/models.ts` import (each embeds parts of the other, so a direct import would be a cycle). The environment result digests changed (manifest regenerated, feac369f4); a node's `agentSettings.defaultAgent` outside the platform list now fails a version-1 decode, as `initialAgentPlatform` already did (7003's rule: a new literal bumps the domain).
- **The terminal session, pane layout and draft schemas became the models.** 7001 wrote them as tolerant readers (every field optional, `sessionType`/`status` as strings) because services are faked in tests with partial records. The storage always writes every field, so the required fields are now required and the vocabularies literals; the backend suites that exercise these commands (152 files, 2,763 tests) found no fake that answered a partial record. `PersistedNativeAgentSession` and `PersistedPromptQueue` stay tolerant: they are large, their nested parts are backend-private or opaque, and the web's types are narrower views; converging them is this item's follow-up.
- **The convergence test** (`tests/unit/model-type-convergence.test.ts`) reads both files' exports (re-exports, `export type { }` of imports, aliases, interfaces, and the web's `export *` of `paneLayout.ts`). A name both export must be the same symbol of the same `@orkestrator/protocol` module, or one side a view declared from the other's protocol symbol; otherwise it must be in `HOMONYMS` or `PENDING`, and an entry of either list that no longer needs to be there fails the test, so the lists only shrink. Options considered: a type-level equality check (`Equals<Backend.X, Web.X>`), which needs a compiled test across two apps' tsconfigs and proves only structural equality; or the TypeScript compiler API (the repository's `typescript` is the 7.x native port, without the classic program API). Chosen: the source-level rule, which makes identity hold by construction (one symbol) and runs in the root unit suite.

### Deviations (orchestrator-assigned, 2026-11-07)

- **One web domain-client helper** (4476f0b3d). There were three: 7001's `nativeSessionsDomainClient`, 7002's `domainApi` (`lib/node-scope/domains/domain-api.ts`) and 7003's `backendDomainApi` (`lib/backend/domain-client.ts`). Kept `domainApi`/`domainClientFor` in `lib/node-scope/domains/domain-api.ts`: it is where the items put domain bindings, it makes one client per factory client and definition (a `WeakMap`; `backendDomainApi` built a new client on every call), and it carries the hot-path result validation the terminal domain needs. Every `backendDomainApi(c, def)` became `() => domainApi(c, def)` (and `backendDomainApi(c, def)()` became `domainApi(c, def)`); `nativeSessions(client)` is `domainApi(client, nativeSessionsClient)`; `lib/backend/domain-client.ts` is deleted. Its builders moved: `machineBackendClient` and `withArgumentsObject` (now made once per client, so a domain client over it is too) to `lib/backend/client.ts`, `routedBackendClient` to `lib/portal/routed-backend-client.ts` (lib/federation may import from lib/portal; its `@/lib/backend/domain-client` imports broke the `@/lib/backend/*` lint restriction). **Empty arguments:** the copies disagreed (7003 sent `{}` as a call without arguments, 7001/7002 sent it as given). Every transport sends both as `args: {}` and the prefetch cache keys them alike, so the difference is only visible to mocked `invoke`. Measured both rules over the whole web suite: "an empty object is a call without arguments" broke 4 expectations, "as given" broke 10; chose the first and updated the four (`nodes.test.ts`, `system.test.ts`, `graph-templates.test.ts`, `graph-template-sharing.test.ts`; `native-sessions.test.ts`'s own binding test likewise). A function that must send `{}` uses `withArgumentsObject(client)`. Not merged: 7009's `backendClientOver` (`node-scope/domains/invoke-over.ts`, a client builder over a bare invoke, uncommitted at the time).
- **One open-record schema helper** (fb918cd7b). `contract/model-schema.ts` holds every variant, documented in a table in its header: `openRecord(fields)` (the old `openStruct`/`openRecord`: fields checked, other keys kept, typed as the declared struct), `modelRecord<T>()` (typed as a protocol interface), `variantRecord<T>()` (unions), `opaqueRecord<T>()`, `OpenObject`, `ownedObject<T>()`, `asModel<T>()` and `mutableArray()` (the old `listOf`). Removed the copies in native-sessions, nodes, agent-servers, system, accounts, coordinator (two), projects, git, environments, graphs and kanban. Same constructions, so no JSON Schema export changed (checked by digesting every exported schema and command before and after). Not touched: 7007's then-uncommitted `pipelines/schemas.ts` and `multi-review/schemas.ts`, which have their own `listOf`/`asModel`/`OpenObject`; they should import `mutableArray`/`asModel` from `model-schema.ts`.
- **7001's boxes:** its native-sessions registrars now register through `withAsyncArgumentFailures` (7d35bb91a), so its async handlers reject on bad arguments again and `commands-registry-native-auth.test.ts` is back to its pre-7001 text; its tests box is ticked. Its models box is ticked with this item's moves (Session, pane layout, drafts, handoff, domain check) and the two records left pending here.

### Where Effect is used (2026-11-07)

- Effect Schema for every model schema; `effect/Types` `Mutable`/`DeepMutable` for the model types. The convergence test and the web helper are plain code (a source parser; promise adapters over 1009's `createDomainClient`).

### Validation (2026-11-07)

- Protocol suite 5,720 pass (`bun test src`); `model-schema.test.ts` 8 pass; `model-type-convergence.test.ts` 4 pass.
- Web: whole suite after every slice, 14,079 pass, 0 fail (948 files); `src/lib` + `src/hooks` 4,668 pass after the helper slice.
- Backend: the 152 suites that name a native-sessions command or build a registry, 2,763 tests: 8 failures, all other items' (projects/config argument rejections, PR monitor, bridge readiness, domain-adapter listing); the 79 suites naming environment commands or agent settings likewise.
- Typecheck: backend (both tsconfigs) and desktop clean; protocol and web report only errors in other items' tests (`projects-config.test.ts`, `terminals-files-tmux.test.ts`, `kanban.test.ts`, `native-sessions.test.ts:42/192/232`) and `agent-handoffs.ts`/`files-sessions.ts` readonly results (present before this item). oxlint and `bun fmt` clean on touched files.
- Manifest regenerated under the contract lock twice (environment and native-sessions result digests). Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): schema helpers converged in `contract/model-schema.ts` (fb918cd7b); one web domain-client helper (4476f0b3d); environment, settings and vocabulary models from the protocol, `config/agent-settings.ts`, the convergence test, manifest (feac369f4); 7001's registrars through `withAsyncArgumentFailures` and its test edit reverted (7d35bb91a); terminal session, pane layout and draft records tightened into the models, manifest (4f3262585); `DomainTestResult` and this bookkeeping (with this entry). Open: the pending rows (7007, 7008, 7009, and the native agent session and prompt queue records here).
