---
id: 7010
title: "Converge backend and web models on protocol schemas"
phase: 7
plan: "§11.2 Definitions and §11.1"
status: done
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
- [x] Replace the duplicated types with the inferred types of the protocol's Effect Schemas (`typeof X.Type`, or `Schema.Schema.Type<typeof X>`; Decision 13.8 changed from Zod to Effect on 2026-11-07). Where the web needs a narrower or derived view type, derive it from the protocol type.
  - [x] The environment, settings, project, terminal session, pane layout, draft and handoff models, and the vocabularies they use (see the table).
  - [x] The rest (the table's former "pending" rows): agent-server catalogues (7009), Multi Review and build pipeline records (7007), Cursor SDK sign-in (7008), and the native agent session and prompt queue records, whose `native-sessions` schemas were tolerant readers (2026-11-07, see Notes).
- [x] A test that fails if a type exported from both `models.ts` and `types/index.ts` under the same name is not the same protocol type. (`tests/unit/model-type-convergence.test.ts`, see Notes.)

## Done when

- [x] Neither file defines a wire model that protocol also defines. `PENDING` is empty; the two homonyms are protocol types or views of them (the backend's stored `Environment` extends `ClientEnvironment` with backend-private fields); the convergence test also fails if either file declares its own copy of a type a contract domain exports. Aggregate suite left to review preparation.

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
| `Environment` | environments | homonym | backend: the stored record, backend-private, `extends Omit<ClientEnvironment, …>` with the private fields (derived, 2026-11-07); web: `ClientEnvironment` without `containerLifecycle`, plus `initialPromptAttachments` (derived) |
| `AppConfig` | config | homonym | backend: `StoredAppConfig` (credentials); web: the protocol `AppConfig` with the redacted fields and the Codex thread limit optional (derived) |
| `ClaudeModelCatalogEntry`, `ClaudeModelCatalogSnapshot` | agent-servers | moved (7010) | effort levels and `source` are literals |
| `PersistedBuildPipeline` | pipelines | moved (backend) / derived (web) (7010) | `BuildPipelineRecord` is the schema's type; the web's is generic over `snapshot` |
| `PersistedNativeAgentSession` | native-sessions | moved (7010) | the schema is the full record; the web's narrower copy is gone |
| `PersistedPromptQueue` | native-sessions | moved (backend) / derived (web) (7010) | the web's is generic over its messages |

**Backend only** (`models.ts`):

| Type | Owner domain | Status |
| --- | --- | --- |
| `ClientEnvironment`, `StartupAgentSessionSnapshot`, `WorktreeMoveRecord`, `WorktreeMoveSubmodule` | environments | moved (7010) |
| `AgentActivitySource`, `AgentActivitySourceSnapshot`, `FrontendAgentActivityObserverSnapshot` | protocol `agent-activity` | moved |
| `PersistedAgentInteractionResolutionJournal`, `PersistedAgentInteractionWorkflowSummary` | protocol `agent-interactions` | moved (aliases) |
| `ClaudeEffortLevel`, `CodexReasoningEffort`, `CodexModelCatalogEntry`, `PersistedAgentModelCatalog`, `AgentModelCatalogCache`, `OpenCodeModelCatalogEntry`, `OpenCodeModelCatalogSnapshot` | agent-servers | moved (7010) |
| `PersistedMultiReviewWorkflow` | multi-review | derived (7010): `MultiReviewWorkflowRecord` plus the controller lease, which never leaves the backend |
| `PersistedNativeAgentPendingDispatch`, `PersistedNativeAgentSignInResend`, `PersistedNativeAgentPendingSteer`, `PersistedNativeAgentRetiredDispatch`, `PersistedNativeAgentTurnOutcome`, `NativeAgentSessionBackendTitle`, `IncompleteTurnNotice`, `NativeAgentJobReceipt`, `NativeAgentProvider` | native-sessions | moved (7010), parts of the session and queue schemas |
| `Environment` | environments | derived (7010): extends `ClientEnvironment` (ports kept `number`, the durable `containerLifecycle`), plus the backend-private fields |
| `AgentActivityCompletionOutcome`, `NativeAgentJobCompletionAction` | environments / native-sessions | local-only (backend activity and job bookkeeping) |

**Web only** (`types/index.ts` and its re-exports):

| Type | Owner domain | Status |
| --- | --- | --- |
| `DomainTestResult` | native-sessions | moved (7010; `DomainResolution`; the backend never answers `resolvable: null`) |
| `EnvironmentSetupSession` | environments | moved (7010; `EnvironmentSetupSessionSnapshot`) |
| `StartEnvironmentResult`, `EnsureEnvironmentSetupResult` | environments | derived (7010; from `EnvironmentSetupStartResult`) |
| `GlobalConfig`, `ContainerResources`, `TerminalAppearance`, `PreferredEditor`, `LastEnvironmentAgentSelection` | config | derived (7010) |
| `GatewayTokenSettings`, `WebClientStatus` | protocol `web-client` | moved |
| `ClaudeCatalogEffortLevel`, `CodexReasoningEffortPreference` | agent-servers | moved (7010; aliases of `ClaudeEffortLevel`, `CodexReasoningEffort`) |
| `CursorSdkAuthStatus`, `CursorSdkLoginProgress` | accounts | moved (7010; `source`/`state` literals) |
| `PersistedWorkflowRecord` | multi-review | derived (7010; `MultiReviewWorkflowRecord` generic over `snapshot`; its never-sent `controllerLease` dropped) |
| `UIState`, `FileMention`, `FileCandidate`, the pane layout tree (`types/paneLayout.ts` apart from `PersistedPaneLayout`) | renderer | local-only |

### Decisions (2026-11-07)

- **Model types are the schemas' types made mutable.** Effect's struct types are `readonly`; the models were mutable and the backend and the renderer write them (storage migrations, store updates). Each protocol module exports the model type as `Mutable<typeof X.Type>` (flat records) or `DeepMutable<…>` (records with nested records or lists), as 7005 did for `Project`. Not `DeepMutable` where a field is `unknown` (it maps `unknown` to `{}`): the drafts and the handoff use `Mutable`.
- **Homonyms are named, not renamed.** `Environment` and `AppConfig` mean different records on the two sides (stored vs sent). Options: rename one side (hundreds of files on either side) or keep the names and document the pair. Kept, in the test's `HOMONYMS` list with each side's meaning; both sides are now protocol types or views of them except the backend's stored `Environment`, which is backend-private (its wire forms are `ClientEnvironment` and `EnvironmentDetail`).
- **The web's `Environment` drops `containerLifecycle`.** A list answers the lifecycle snapshot there and `get_environment` the durable record (`EnvironmentDetailSchema` types it as an object), so a single field type would be wrong for one of them; the renderer never read it and reads the snapshot through `get_container_lifecycle_snapshot`.
- **The web's `GlobalConfig` is derived, not the protocol's.** The protocol's `GlobalConfig` (the renderer view 7005 defined) requires the redacted credentials' `*Configured`/`*Source` and `codexMaxConcurrentThreads`; the web declared them optional and its settings drafts and fixtures omit them. Chosen: `Omit<GlobalConfig, those> & Partial<Pick<…>>`, so every other field is the protocol's.
- **`AgentSettingsTierSchema` replaces 7003's placeholder.** The environment model's `agentSettings` was `ownedObject<AgentSettingsTier>()` (any object). The tier, the platform literals and the launch-mode literals moved to `contract/domains/config/agent-settings.ts`, which both `environments/models.ts` and `config/models.ts` import (each embeds parts of the other, so a direct import would be a cycle). The environment result digests changed (manifest regenerated, feac369f4); a node's `agentSettings.defaultAgent` outside the platform list now fails a version-1 decode, as `initialAgentPlatform` already did (7003's rule: a new literal bumps the domain).
- **The terminal session, pane layout and draft schemas became the models.** 7001 wrote them as tolerant readers (every field optional, `sessionType`/`status` as strings) because services are faked in tests with partial records. The storage always writes every field, so the required fields are now required and the vocabularies literals; the backend suites that exercise these commands (152 files, 2,763 tests) found no fake that answered a partial record. `PersistedNativeAgentSession` and `PersistedPromptQueue` stay tolerant: they are large, their nested parts are backend-private or opaque, and the web's types are narrower views; converging them is this item's follow-up.
- **The convergence test** (`tests/unit/model-type-convergence.test.ts`) reads both files' exports (re-exports, `export type { }` of imports, aliases, interfaces, and the web's `export *` of `paneLayout.ts`). A name both export must be the same symbol of the same `@orkestrator/protocol` module, or one side a view declared from the other's protocol symbol; otherwise it must be in `HOMONYMS` or `PENDING`, and an entry of either list that no longer needs to be there fails the test, so the lists only shrink. Options considered: a type-level equality check (`Equals<Backend.X, Web.X>`), which needs a compiled test across two apps' tsconfigs and proves only structural equality; or the TypeScript compiler API (the repository's `typescript` is the 7.x native port, without the classic program API). Chosen: the source-level rule, which makes identity hold by construction (one symbol) and runs in the root unit suite.

### The pending rows converged (2026-11-07, second pass)

- **Catalogues** (`agent-servers/schemas.ts`): `ClaudeEffortLevel`, `ClaudeModelCatalogSource` and `CodexReasoningEffort` are literal schemas, used by the Claude, Codex and OpenCode catalogue schemas, which are the models (`Mutable`/`DeepMutable` of the schema types). Literals, not 7009's strings, because the backend keeps only the values it knows when it reads a catalogue (`commands-containers.ts` filters effort levels, `storage-shared-model-catalogs.ts` and `commands-validation.ts` refuse others), so a string type promised less than the backend guarantees. `schemaVersion` is `Literal(1)` (the host cache) and `Literal(2)` (OpenCode). `AgentModelSchema` is now `modelRecord<AgentModel>()` (same run-time shape, typed as the protocol interface); `AgentModelCatalogCache` is the schema's type with each platform's catalogue typed as `PersistedAgentModelCatalog<entry>` (a generic interface beside the schema, since a generic cannot be inferred). The OpenCode entry gained `connected?` in the model (the backend writes it, `commands-registry-servers.ts`).
- **Workflow envelopes**: `BuildPipelineRecord` (pipelines) and `MultiReviewWorkflowRecord` (multi-review) were interfaces with all-optional schemas; they are now `openRecord` schemas with the fields storage always writes required (`activityEndedAt`, and the workflow's `snapshot`, optional), and their types the schemas'. The web's `PersistedBuildPipeline<T>` and `PersistedWorkflowRecord<T>` are views (`Omit<…, "snapshot"> & { snapshot: T }`); the web's `controllerLease` is gone (the backend strips it, `stripWorkflowRendererSecrets`; no web code read it). The backend's `PersistedMultiReviewWorkflow` is the record plus the lease. `pipelines/schemas.ts` and `multi-review/schemas.ts` import `mutableArray`/`asModel` from `model-schema.ts` (their `listOf`/`asModel` copies removed; their `OpenObject` was `opaqueRecord<Record<string, unknown>>()`, a different run-time shape from `model-schema.ts`'s `OpenObject`, so it stays as a local `OpaqueObject` built with the shared helper; no digest moved, checked with `contract:check` after that step alone).
- **Cursor SDK sign-in** (`accounts/schemas.ts`): credential source and login state are literals (the backend writes only these, `cursor-sdk-bridge.ts`); `CursorSdkAuthStatus`/`CursorSdkLoginProgress` are the schemas' types and the web re-exports them.
- **Native agent session and prompt queue** (`native-sessions/schemas.ts`): full schemas of both records and every part (`PendingDispatchSchema`, `SignInResendSchema`, `PendingSteerSchema`, `RetiredDispatchSchema`, `TurnOutcomeSchema`, `BackendTitleSchema`, `IncompleteTurnNoticeSchema`, `NativeAgentJobReceiptSchema`, `NativeAgentProviderSchema`); required fields are the model's, `agent` and `origin` literals (`AGENT_PLATFORMS`, `AGENT_INTERACTION_ORIGINS`). Options for the fields the backend reads through its own validating reader so that "a malformed value reads as absent" (`retiredDispatch`, `deliveredAgentHandoffIds`, `signInResend`, `goal`, `goalHistory`, `resumeIdentity`, `backendTitle`): validate them in the decode (a malformed stored value would make `get_native_agent_session` fail on every client, the opposite of the backend's rule), or type them without checking. Chosen: `selfValidated<T>()` = `optional(asModel<T>(Schema.Unknown))`. Parts that are another protocol module's interfaces (`owner`, `policy`, `controls`, `interactionPolicy`, `initialPromptPresentation`, the command intent) are `asModel<T>(OpenObject)`, as before at run time. `failureKind` stays a string at run time (an older backend ignores the field; readers classify an unknown kind by `error`). The web's `PersistedNativeAgentSession` is the protocol's (wider than its old copy, every added field optional); its `PersistedPromptQueue<T>` is a view generic over the messages.
- **The backend's stored `Environment`** now `extends Omit<ClientEnvironment, "containerLifecycle" | "hasInitialPromptAttachments" | ports>` and declares only the backend-private fields, the durable `containerLifecycle` and the ports (stored as `number`; the client form admits `null`). Its client fields' documentation moved to `clientEnvironmentFields` in `environments/models.ts` (comments only; outside this item's listed files, no schema change). Options: keep the homonym as a separate interface (60 duplicated field declarations that drift from the wire form), or derive it; derived, and backend typechecked clean without other edits.
- **Test guard for "Done when"**: `model-type-convergence.test.ts` gained "neither file declares its own copy of a type a protocol domain defines": a locally declared, non-derived type in either file under a name any `contract/domains/**` module exports fails (homonyms excepted). Checked that it fails on an injected copy.
- **Fakes**: tightening made two backend fakes answer invalid records: `commands-state-sync.test.ts` (`{ operation: "ensure", input }` for `ensure`/`dispatch`/`adopt`; now spread over a complete `nativeSessionRecord()`) and `index.test.ts` (`{ providerSessionId, ...input }`; the input's `origin: undefined` overwrote the record's). The protocol tests' fixtures were not records of the model (`version: 2`, `origin` an object) and now are, with checks that a missing required field, an unknown provider and an unknown effort level fail, and that a malformed self-validated field does not.
- **Digests:** the agent-servers, accounts, pipelines, multi-review and native-sessions result digests changed (manifest regenerated under the contract lock, in this commit). 7003's rule applies: a new literal in these vocabularies bumps the domain.
- **Left outside the two files** (not wire-model definitions in `models.ts`/`types/index.ts`, so outside "Done when"; for a later cleanup): backend `cursor-sdk-bridge.ts` still declares its own `CursorSdkAuthStatus`/`CursorSdkLoginProgress` (could re-export the protocol's), and the web's `lib/backend/config-integrations.ts` its own `AgentModelCatalogCache` (could be the protocol's).

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
- Second pass (2026-11-07): protocol suite (`bun test src`) pass; `model-type-convergence.test.ts` 5 pass (and fails on an injected copy); backend: the 123 suites naming a native-sessions, pipelines, multi-review, catalogue or Cursor command or building a registry, 2,588 tests: after the two fake fixes the remaining failures are other items' (`create_project_from_scratch`, GitHub clone boundaries, renderer adapter-usage count, project summary icons, bridge readiness's "Unexpected arguments", PR monitor disarm, two config-patch/inherited-settings suites); web: whole suite 14,078 pass, 1 fail (`RealmTitleBar.test.tsx`, 4001's component mid-conversion: `useNodeScope()` outside a provider). Typecheck: protocol, backend (both tsconfigs), desktop and web clean. `contract:check` and `contract:adapters:check` pass; oxlint and `bun fmt` clean on touched files.

## Work log

- 2026-11-07 (claude-worker): schema helpers converged in `contract/model-schema.ts` (fb918cd7b); one web domain-client helper (4476f0b3d); environment, settings and vocabulary models from the protocol, `config/agent-settings.ts`, the convergence test, manifest (feac369f4); 7001's registrars through `withAsyncArgumentFailures` and its test edit reverted (7d35bb91a); terminal session, pane layout and draft records tightened into the models, manifest (4f3262585); `DomainTestResult` and this bookkeeping (with this entry). Open: the pending rows (7007, 7008, 7009, and the native agent session and prompt queue records here).
- 2026-11-07 (claude-worker): the pending rows converged (0134c2671): agent-server catalogues, workflow envelopes, Cursor sign-in, native session and prompt queue records are the protocol schemas (literals, required storage fields); pipelines/multi-review schema helpers from `model-schema.ts`; the backend's stored `Environment` extends `ClientEnvironment`; `PENDING` empty and a guard against local copies of domain types; two backend fakes completed; manifest regenerated under the lock; `version-compatibility.md` schema rules updated. Every box ticked; status done.
- 2026-11-07 (claude-worker): the last duplicates from this item's report removed: backend `cursor-sdk-bridge.ts` re-exports `CursorSdkAuthStatus`, `CursorSdkLoginProgress` and `CursorSdkLoginState` from `@orkestrator/protocol/contract/domains/accounts`, and web `lib/backend/config-integrations.ts` re-exports `AgentModelCatalogCache` from `contract/domains/agent-servers`. Shapes checked identical first (same fields and literals; the protocol's `Schema.optional` fields are `T | undefined`, the same type without `exactOptionalPropertyTypes`, which no package sets; the web's `CodexModel` and `ClaudeModelCatalogSnapshot["models"]` are structurally the protocol's catalogue entries). Backend and web typecheck clean; `agent-sign-in-status`, `cursor-sdk-login`, web settings-agent, catalogue cache and `lib/backend` suites pass.
