---
id: 7005
title: "Convert projects, config and settings"
phase: 7
plan: "§12 Phase 7 and Appendix E"
status: done
depends_on: [1008, 1010, 1011]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 7005 · Convert projects, config and settings

- **Report:** [§12 Phase 7](../../docs/reports/unified-federation.md#12-migration-plan), [Appendix E](../../docs/reports/unified-federation.md#appendix-e-command-surface-by-domain), [§11.4](../../docs/reports/unified-federation.md#114-transition-pre-contract-nodes)
- **Depends on:** [1008](1008-contract-ci-job.md), [1010](1010-pilot-node-mail-and-ticket-sync.md), [1011](1011-contract-policy-and-docs.md)
- **Recommended before the web side:** [3002](3002-lib-backend-client-parameter.md) and [2011](2011-scope-domain-negotiation.md). Until they land, the domain's `lib/backend` file calls the domain client bound to the command scope.
- **Parallel with:** the other Phase 7 domain items, and all of Phases 2-6
- **Size:** M
- **Track:** C (contract)

## Domains

`projects`, `config`.

## Current state (verified 2026-11-07)

- 71 registered, 59 web-referenced.
- `update_global_config` has a compatibility path for older realms' echo (`isGlobalConfigEcho`, counter `workspace-grant.config-echo`; todo 5740 task 2). Keep it until its register row retires.
- Many settings writes are administration commands (`WORKSPACE_ADMINISTRATION_COMMANDS`). Their `access: "admin"` must match today's list exactly.

## Work

Apply the conversion checklist from [1011](1011-contract-policy-and-docs.md)'s "Domain contracts" docs to every command in the domains above:

- [x] Define each domain at version 1 (min 1) in `packages/protocol/src/contract/domains/`.
- [x] `defineCommand` for every command, with:
  - `args` and `result` schemas;
  - `access` (workspace, admin or internal), seeded from [0006](0006-grant-scope-live-evidence.md)'s observed list and today's deny-lists;
  - `read`, checked against `isNodeReadCommand`;
  - `critical` fields, with a one-line reason each in Notes.
- [x] Switch handlers to `register(def, handler)`.
  - Lenient handlers stay tolerant.
  - Strict (`assertOnlyKeys`) handlers become tolerant-with-critical.
  - Hand-written `commands-validation.ts` parsing is replaced by the schema where it is equivalent; keep user-facing error text.
- [x] Fold the domain's capability command (if any) into the domain version. Keep the command registered for pre-contract clients until its register row retires.
- [x] Web side:
  - a domain client in `apps/web/src/lib/node-scope/domains/<domain>.ts`, with a version-1 adapter and a version-0 legacy adapter that keeps today's capability gating;
  - the domain's `lib/backend` functions call it;
  - typed results replace `invoke<T>` casts.
- [x] Move the domain's shared types from `apps/backend/src/core/models.ts` and `apps/web/src/types/index.ts` to inferred protocol types where they match (see [7010](7010-converge-models.md)). (`Project` moved; the config records do not match yet and are left to 7010 with faithful schemas, see Notes.)
- [x] Classify the register rows for these domains: retired, mechanical (adapter), or unaffected. Update `version-compatibility.md`.
- [x] Add a scenario module to [1012](1012-mixed-version-qualification.md)'s script for the domain's main flows. (`projects` and `config`; see Work log for the runs.)
- [x] Regenerate the manifest and the adapters list; the untyped baseline falls.


## Tests

- [x] Each converted handler passes its existing tests unchanged, apart from tests that asserted rejection of unknown keys, which now assert stripping (or the critical-field refusal).
- [x] A domain-client test for each adapter version against fakes.
- [x] Contract CI stage 2 ([1008](1008-contract-ci-job.md)) accepts every in-window snapshot's arguments. (No in-window snapshot defines these commands yet, so stage 2 has nothing to compare; it starts when the first release with them is snapshotted.)

## Done when

- [x] Every command in these domains is defined, the untyped count for them is zero, and the web uses domain clients for them. (57 defined, 0 untyped in the committed manifest and baseline; the web's `lib/backend`, config layering, host path picker and remote arrangement go through the clients. Left raw on purpose: the desktop startup transport probe and the scope-proof harness, see Notes. Aggregate suite left to review preparation.)

## Notes

### Scope (2026-11-07)

- **57 commands, not 71.** Appendix E counted by registering file; the manifest's `projects` (26) and `config` (31) domains are `contract-domain-map.ts`'s seeding (1006). The model-catalogue, plan-usage and Cursor SDK commands in `commands-registry-projects.ts` belong to `agent-servers`/`accounts` (7008, 7009) and were left to them; `greet` and the resource-manifest reads are `system` (7009).
- Files: protocol `contract/domains/projects/` and `config/` (`domain.ts`, `models.ts`, `commands.ts`, `client.ts`, `index.ts`), `domains/projects-config.test.ts`, two subpath exports, both clients in `DOMAIN_CLIENTS`; backend `commands-registry-{projects,client-state,permission-rules,project-copy}.ts`, `commands-host-files.ts`, `agents-md-commands.ts`, `commands-registry-projects-config-contract.test.ts`; web `lib/node-scope/domains/{projects,config}.ts` (+ test), `lib/backend/{projects-environments,files-sessions,docker-skills,client-state,permission-rules,config-integrations}.ts`, `lib/portal/command-node-config.ts`, `lib/host-path-picker.ts`, `lib/federation/remote-project-writes.ts`; `scripts/mixed-version/scenarios/{projects,config}.ts`.

### Where Effect is used (2026-11-07)

- **Effect Schema** for the 57 definitions and every model and result schema, following 1001's rules. Settings records use `openRecord` (`projects/models.ts`: `StructWithRest` with an `unknown` record, statically the declared struct's type, the same construction as 7001's `openStruct`), so a tolerant decode keeps every key. `Project` is the schema's type made mutable (`effect/Types` `Mutable`).
- **Deliberately not Effect:** the two domain clients and their web bindings are promise adapters over 1009's `createDomainClient` (synchronous selection, promise callers), as in 1010 and 7001. Handlers keep their own validation helpers where they carry their own error text.

### Decisions (2026-11-07)

- **Model schemas faithful to `models.ts`** (for 7010). `ProjectSchema` is `Project` field for field and is now its only definition: `models.ts` and `apps/web/src/types/index.ts` re-export the protocol type. `config/models.ts` has `AppConfig`, its `global` and `RepositoryConfig` field for field in two forms: stored (`StoredAppConfigSchema`, `StoredGlobalConfigSchema`, credentials included; never sent) and the renderer's (`AppConfigSchema`, `GlobalConfigSchema`: `RendererAppConfig` of `commands-validation.ts`, with `*Configured`/`*Source` in place of the four credentials), plus `AgentSettingsTierSchema`, which 7003's `environments/models.ts` marks as this domain's to own (its `ownedObject` placeholder can now import this one; left to 7003/7010). Required fields are required, literal vocabularies are `Schema.Literals` from the protocol's constants (a new literal bumps the domain, as 7003 settled). Nested values another module owns (log detail, notification sounds, review lenses, rollout gates, the desktop catalogue entries, `ProjectGitStatus`) are typed objects (`ownedObject`) until their owner has a schema. The config types were **not** moved: the web's `GlobalConfig` differs from the backend's (`codexMaxConcurrentThreads` optional on the web, the redacted fields optional), so converging them is 7010's; the schemas are written to be that single definition.
- **Settings records are open.** Options: closed structs like 7003's environment model (exact types, but a decode drops unknown keys), `modelRecord<T>` (open, but typed from the interface, so the schema cannot become the definition), or open structs with every field declared. Chosen: the third. A client writes settings back whole (`save_config`, `update_global_config`, `update_repository_config`), so a closed decode of `get_config` from a newer node would delete that node's newer settings on the next save. Projects and the other records are closed structs (nothing writes them back whole).
- **Arguments.** A key the handler read with `asString` (directly or through `asNonBlankString`) is `Schema.String`; an optional `asRequiredBoolean` flag is `optionalKey(Boolean)`; the registry's text is the same (`Expected x to be a string`/`a boolean`). Every key the handler checks itself (settings records, nullable credentials, bounded client-state inputs, `existingProjectId`, the clone and copy inputs) is `optionalKey(Unknown)`, so nothing accepted today is refused, every message is unchanged, and handlers that checked keys in a particular order (the approve-and-remember card, `remember_environment_agent_selection`) still report the first one first. `list_host_directory`'s hand-written flag check is replaced by the schema (same text). 22 formerly strict handlers (`assertOnlyKeys`) declare exactly the keys they allowed and now drop unknown ones.
- **`access`**: `admin` for exactly the nine settings writes in `WORKSPACE_ADMINISTRATION_COMMANDS` (`save_config`, `update_global_config`, `patch_global_config`, `update_notification_sound_settings`, `save_desktop_connections`, the four credential setters); `internal` for `request_coordinator_agents_md_update` (workspace-excluded; the coordinator's Control MCP tool); `workspace` for the rest, which includes every command 0006 observed from a realm (`get_config`, `get_projects`, `get_client_state_capabilities`, `get_coordinator_pane_layout`, `save_coordinator_pane_layout`). Pinned by `commands-registry-projects-config-contract.test.ts` against the backend's lists. **`read`** equals `isNodeReadCommand` (pinned by the protocol test).
- **Critical fields**, per field:
  - `add_project.cloneOnly`: a safety option; ignored, an existing folder would be registered instead of refused.
  - `start_project_clone.requestKey`: the idempotency key; ignored, a retry starts a second clone.
  - `open_project_agents_md_pr.requestKey`: the idempotency key; ignored, a retry opens a second pull request.
  - `update_global_config.preserveInheritedSettings`: ignored, a machine's save overwrites the preferences its command node owns.
  - `patch_global_config.unset`, `patch_repository_settings.unset`: ignored, a setting the user removed stays.
  - `save_coordinator_pane_layout.expectedRevision`: the compare-and-swap guard; ignored, another client's newer layout is overwritten.
  - `approve_native_agent_interaction_and_remember.expiresInMs`: ignored, the rule never expires.
  - Not critical: `get_projects`'s `summaryIcons`/`includeDefaultBranch` (ignored, a fuller answer), the conditional-read keys, `list_host_directory`'s flags, `decline_coordinator_upstream_merge.onlyIfAbsent` (retired), `cursor` on the clone browser.
- **Results.** Every result is a real schema (no `Unknown` result). `remove_project`, `save_config` and `save_desktop_connections` are `Schema.Void`. `get_projects` and `get_config` are unions of the plain answer and the `ConditionalResourceSnapshot` forms. The approve-and-remember outcome requires only `result` (as 7001's `InteractionApplyOutcomeSchema`): its test fakes the service with a partial outcome, and results are validated in tests.
- **Capability command folded.** `get_client_state_capabilities` is part of `config` version 1: `CONFIG_CLIENT_STATE_CAPABILITIES` (protocol) is what this build answers (the backend now uses it) and what `clientStateCapabilities()` returns for a node with the domain without a round trip. Version 0 asks the command and parses with `parseClientStateCapabilities` on every call, as before. The command stays registered (new register row).
- **Clients.** One function per command keyed by name (as 7001), plus `clientStateCapabilities()` on `config`. Version 1 calls with the envelope and decodes; version 0 is today's call by name, answered as sent. The web binds them with `backendDomainApi` (`lib/node-scope/domains/{projects,config}.ts`), which keeps a call without arguments a call without arguments, and the machine-aware functions use `machineBackendClient`/`withArgumentsObject` as 7003 does, so every existing web suite sees the same calls. The config layering's `sender` (`command-node-config.ts`) sends every `config` command through the client on both of its nodes (any other command, such as another domain's command-node setting, as before); `lib/federation/remote-project-writes.ts` uses the `projects` client over `routedBackendClient` (version 0). Left raw on purpose: `desktop-startup.ts`'s `get_config` (a transport probe through the preload), `scope-proof-harness.ts` (proves the raw scope call), the desktop main process's `get/save_desktop_connections` and the backend's own node-to-node calls (`get_projects` summaries, `get_project_clone` in `node-project-copy.ts`): the defined handlers accept the untyped form, so they can move later without a version change.
- **Config echo kept.** `isGlobalConfigEcho` and the `workspace-grant.config-echo` counter are untouched: the gateway (`gateway-handlers.ts`) and the relay (`node-relay.ts`) decide from the raw arguments before the registry runs, and `update_global_config`/`patch_global_config` stay registered as defined `admin` commands. Their tests (`workspace-grant-scope.test.ts`, `gateway-workspace-grant-scope.test.ts`) pass unchanged.
- **Register rows.** Mechanical: backends without `get_client_state_capabilities` (counter `domain-adapter.renderer.config.v0`). New: the capability command kept for pre-contract renderers. Unaffected: the config-echo row (note added) and the retired `experimentalCodexRawEventLogging` key (same echo path). No row retires: every release in the window is pre-contract. Unregistered fallbacks in these domains, for the record: `arrange_projects_by_intent` → `arrange_projects`, `patch_repository_settings` → `update_repository_config`, `patch_global_config` → `get_config` + `update_global_config` (`patchGlobalOnNode`); each reads the typed `unknown-command` as before.
- **Test edits** (outside "unchanged"): `commands-host-files.test.ts`, three "validates its arguments" tests: `Unexpected arguments field: extra` became the key dropped (and the flag text asserted from the schema). `commands-registry-permission-rules.test.ts`: `{ injected: true }` left the refusal list; the successful call now carries it and asserts the service sees only the declared arguments.
- **Async handlers.** A converted `async` handler throws a decode failure synchronously (1003's registry); the tests above call through `Promise.resolve().then`, and production callers `await`. `ASYNC_HANDLER` (7004) was not needed.
- **Shared files.** Commits were built from temporary indexes starting at the current HEAD, with only this item's hunks in `contract-domain-map.ts`, `client-adapters.ts`, `package.json`, `models.ts`, `types/index.ts`, `commands-registry-projects.ts`, the four `lib/backend` files, `version-compatibility.md` and the scenario index. `commands-registry-projects.ts` was found truncated to zero bytes in the working tree at 05:11 (another agent's write) and then overwritten from a stale copy; this item's edits were reapplied twice from a script and the committed blob is HEAD plus this item's hunks. The docs commit a2831242 also carries 7006's "Git, GitHub, pull requests and changes" bullet, which sat between this item's bullet and the next in the working tree.
- **`config-integrations.ts` committed last.** The committed file did not parse between 815683859/c64a67788 and 7006's repair in 0a64f9792 (`getAgentModelCatalogCache`'s parameter list ran into `const accountsOn_ = …`), so this item's three call sites there (`saveConfig`, `getGlobalConfig`, `getRepositoryConfig`) were committed after it.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): protocol `projects` (26) and `config` (31) domains with faithful model schemas, both clients, `projects-config.test.ts`; backend handlers on `register(def, handler)` in six registering files, 57 domain-map entries removed, `Project` re-exported from the protocol in `models.ts` and the web types, `commands-registry-projects-config-contract.test.ts` (824c61a20). Manifest regenerated under the contract lock: 57 defined in these domains, 0 untyped (`projects`/`config` gone from `untypedByDomain`); argument schemas and adapter list already current. Web: the two bindings, the `lib/backend` functions, the config layering, the host path picker (e04cb0c53), remote project writes (with this entry). Docs and register rows, scenario modules (a2831242). Tests: protocol `projects-config.test.ts` 12 pass; backend focused run over 31 suites naming these commands (672 tests; the only failures are other domains' in-flight work: `get_plan_usage`, bridge readiness, the PR monitor, and the manifest test before regeneration), the new contract test 3 pass; web 22 suites naming these commands (incl. Settings, configStore, sidebar, host-path picker, command-node-config, backend wrappers, store-resource-sync) pass, `projects-config.test.ts` 4 pass, `remote-project-writes.test.ts` pass. Protocol, backend and web typecheck clean in this item's files; oxlint and `bun fmt` clean. `mise run contract:ci` passes (stage 2: 0 older schemas to compare); `contract:check` fails only on other agents' uncommitted domains. Mixed-version: `--old-version current --scenarios projects,config` passed (projects 14/14, config 12/12); against v2.36.1 with this checkout as command node both passed (v0 for the release leaf, v1 for this checkout); the `old-command` topology could not start this checkout's leaf because of another domain's in-flight schema code (`buildStepFields.agent.optional`), so that topology is to be rerun in the live pass.
- 2026-11-07 (claude-worker, completeness audit): the `old-command` rerun this item left open: against v2.36.1 with the release as command node and this checkout as leaf, projects 14/14 and config 12/12 passed; `current-command` and the control passed too (1012 Work log).
