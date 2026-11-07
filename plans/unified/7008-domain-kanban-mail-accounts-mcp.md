---
id: 7008
title: "Convert Kanban, agent mail, agent accounts and MCP management"
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

# 7008 · Convert Kanban, agent mail, agent accounts and MCP management

- **Report:** [§12 Phase 7](../../docs/reports/unified-federation.md#12-migration-plan), [Appendix E](../../docs/reports/unified-federation.md#appendix-e-command-surface-by-domain), [§11.4](../../docs/reports/unified-federation.md#114-transition-pre-contract-nodes)
- **Depends on:** [1008](1008-contract-ci-job.md), [1010](1010-pilot-node-mail-and-ticket-sync.md), [1011](1011-contract-policy-and-docs.md)
- **Recommended before the web side:** [3002](3002-lib-backend-client-parameter.md) and [2011](2011-scope-domain-negotiation.md). Until they land, the domain's `lib/backend` file calls the domain client bound to the command scope.
- **Parallel with:** the other Phase 7 domain items, and all of Phases 2-6
- **Size:** M
- **Track:** C (contract)

## Domains

`kanban` (and Linear), `agent-mail`, `accounts` (accounts and usage), `mcp`.

## Current state (verified 2026-11-07)

- Kanban and Linear: 29 registered, 28 web. Agent mail: 23 and 20. Agent accounts and usage: 28 and 27. MCP management: 13 and 11.
- Kanban tickets keep the same id on every node (`command-nodes.md:803`), so results must stay node-scoped on the client.
- Accounts handlers are strict (27 `assertOnlyKeys` sites).
- MCP snapshots carry `protocolVersion` (Appendix F). Keep it.
- The MCP correlation wrapper (`commands-registry-mcp.ts:579`) must forward defs ([1003](1003-backend-register-overload.md)).

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
- [x] Move the domain's shared types from `apps/backend/src/core/models.ts` and `apps/web/src/types/index.ts` to inferred protocol types where they match (see [7010](7010-converge-models.md)).
- [x] Classify the register rows for these domains: retired, mechanical (adapter), or unaffected. Update `version-compatibility.md`.
- [x] Add a scenario module to [1012](1012-mixed-version-qualification.md)'s script for the domain's main flows.
- [x] Regenerate the manifest and the adapters list; the untyped baseline falls.


## Tests

- [x] Each converted handler passes its existing tests unchanged, apart from tests that asserted rejection of unknown keys, which now assert stripping (or the critical-field refusal). (2026-11-07: the other edits only correct fakes that answered shapes the real code never returns (agent-mail conversation and message fakes, the feature-planning fakes), which is not a behaviour change, the rule 7010 applied to 7001; the accounts message order is restored in the handlers, Notes "Test edits". The focused suites pass; the aggregate suite is left to review preparation.)
- [x] A domain-client test for each adapter version against fakes.
- [x] Contract CI stage 2 ([1008](1008-contract-ci-job.md)) accepts every in-window snapshot's arguments. (`mise run contract:ci` passes with stage 2 on; no in-window snapshot has a defined command of these domains yet, so 0 fixtures today.)

## Done when

- [x] Every command in these domains is defined, the untyped count for them is zero, and the web uses domain clients for them. (98 commands: `kanban` 29, `agent-mail` 23, `accounts` 33, `mcp` 13; `untypedByDomain` has none of them. Every web call site goes through `lib/node-scope/domains/{kanban,agent-mail,accounts,mcp}.ts` or `scope.domain(kanbanClient)`.)

## Notes

### Scope (2026-11-07)

- **98 commands**, the manifest's four domains (`contract-domain-map.ts`, seeded by 1006): `kanban` 29 (`commands-registry-kanban.ts`, `commands-registry-linear.ts`), `agent-mail` 23 (`commands-registry-mail.ts`), `accounts` 33 (`commands-registry-accounts.ts`, `commands-registry-usage.ts`, and the Cursor SDK login and `get_plan_usage` handlers in `commands-registry-projects.ts`), `mcp` 13 (`commands-registry-mcp.ts`). The item's "Current state" counts predate the OpenCode provider logins and the Cursor and plan-usage commands that 1006 placed in `accounts`.
- Files: `packages/protocol/src/contract/domains/{kanban,agent-mail,accounts,mcp}/` (`domain.ts` new for `kanban` and `agent-mail`; `schemas.ts`, `commands.ts`, `client.ts`, `index.ts`, a test each; 7011's `events.ts` unchanged), four subpaths in `packages/protocol/package.json`, the four clients in `DOMAIN_CLIENTS`; web `lib/node-scope/domains/{kanban,agent-mail,accounts,mcp}.ts` (+ tests) and `lib/backend/{kanban,agent-mail,agent-accounts,opencode-provider-auth,usage,mcp-management,config-integrations}.ts`, `lib/federation/node-environment-reads.ts`, `lib/node-scope/scope-proof-harness.ts`; `scripts/mixed-version/scenarios/{kanban,agent-mail,accounts,mcp}.ts` in `SCENARIOS`.
- **Not converted here:** the four lenient neighbours 1010 left string-registered in `node-mail` (`send_coordinator_command_node_mail`, `prepare_node_mail_attachments`, `place_node_mail_attachments`) and `ticket-sync` (`coordinator_node_ticket`). 1010's Notes say they "move with Phase 7 (7008)", but they are not in this item's domains and the brief named node-mail and ticket-sync as done. With `public_action` they are the 5 untyped commands left; the orchestrator should assign them (each is lenient: all arguments `optionalKey(Unknown)`, real results).
- Work was split by domain: `kanban` and `accounts` were converted by two forks of this agent (before the brief's "no sub-agents" rule was added), `mcp` and `agent-mail` and the shared files (client list, scenario list, docs, this file) by this agent.

### Where Effect is used (2026-11-07)

- **Effect Schema** for every definition and result, following 1001's rules. Results over a protocol type use 7004's `modelRecord<T>()` (declared fields validated, every other key passes through a tolerant decode, typed as the protocol's own interface: `McpManagementSnapshot`, `AgentMailMessage`, `AgentAccountsSnapshot`, `FeaturePlanningRecord`, ...); records whose type lives only in the backend (Kanban tickets, plans, notes, Linear, Cursor) are open structs (7001's `openStruct`). `Schema.mutable` keeps the array results assignable to the web's mutable types. Enumerations a newer backend may extend are `Schema.String`; optional result fields are `Schema.optional` (the services spread explicit `undefined`, e.g. `readOnlyReason`).
- **Deliberately not Effect:** the domain clients are promise adapters over 1009's `createDomainClient` with 7002's `commandApi`/`legacyCommandApi` (synchronous selection, promise callers), and the handlers keep their own checks (`required`, `asAccountPlatform`, `McpManagementService`'s structured errors) where they carry their own text. The held-mail counter is the existing `compatibilityPathUsage` recorder.

### Decisions (2026-11-07)

- **Arguments.** Every key a handler reads is declared (a defined command drops undeclared keys before the handler); the tests pin each definition's keys against the handler's former reads. Keys a handler required with `asString`/`asNonBlankString`/`asRequiredBoolean` are typed where the schema gives the same text (`Expected projectId to be a string`); keys read leniently or checked with their own message are `optionalKey(Unknown)`. All mail, MCP and Linear handlers were lenient, so their arguments are all `optionalKey(Unknown)`: MCP's service still answers `invalid-request`/`unknown-target` with its correlation id, mail its `environmentId is required`.
- **Strict made tolerant:** the 29 `assertOnlyKeys` accounts handlers (27 in `commands-registry-accounts.ts`, plus `get_usage_history` and `get_plan_usage`), and six Kanban ones (`record_kanban_criteria_checks`, `update_feature_plan`, `start_feature_planning`, `get_feature_planning_snapshot`, `retry_feature_planning`, `cancel_feature_planning`). Kept strict on purpose: the nested `checks[]` items of `record_kanban_criteria_checks` and the plan `updates` record (values, not argument keys, as 7001 did). No handler of these domains used `commands-validation.ts`, so nothing there was replaced.
- **Async handlers:** registered with 7002's `ASYNC_HANDLER` (accounts, Linear) or 7003's `withAsyncArgumentFailures` (mail), so an argument refused by the decode is still a rejection. MCP's handlers run under `mcpCorrelatedRegistrar`, which forwards definitions (1003's `wrapRegistrar`); none of their arguments can fail the decode.
- **`access`:** `workspace` for every command (none is in `isWorkspaceExcludedCommand`; 0006 saw a realm call `get_kanban_tasks`, `get_feature_plans`, `get_agent_mail_summary` and open the agent and usage popovers; a leaf's own window runs its sign-ins), except `admin` for `get_mcp_management_rollout`/`set_mcp_management_rollout`, the operator kill switch no window calls. `send_external_agent_mail` stays `workspace` like the public API action that calls it. 7012 may narrow `connect_linear`/`disconnect_linear` (a machine-wide key) and the credential-bearing account commands. **`read`** equals `isNodeReadCommand(name)` in every domain test.
- **Critical fields**, per field:
  - `add_kanban_task.requestId`, `add_kanban_comment.requestId`, `send_agent_mail.requestId`, `send_external_agent_mail.requestId`: the idempotency key; a receiver ignoring it creates or delivers a retry twice.
  - `add_kanban_task`/`update_kanban_task` `markdown`, `sections`: ignored, the ticket's content is silently not written.
  - `add_kanban_comment.projectId`: the project guard; ignored, a comment can land on another project's ticket with the same id (ids are the same on every node).
  - `start_feature_planning.operationId`: the exchange's identity the caller tracks; ignored, the record carries another id.
  - `start_agent_account_login.reauthenticate`: ignored, a new account is added instead of the active one renewed.
  - `cancel_agent_account_login.operationId`, `cancel_opencode_provider_login.operationId`: ignored, whichever login is running is cancelled, possibly another client's.
  - `set_opencode_provider_api_key.metadata`, `start_opencode_provider_login.inputs`: ignored, the login is stored without the provider's required details.
  - `retry_agent_mail_inject.now` (Deliver now): ignored, the message is not steered into the running turn.
  - `list_agent_mailboxes.strictProjectScope`: ignored, a coordinator that asked for its own project's mailboxes is shown other projects' too.
  - Not critical: the conditional-read pair (`knownManifestGeneration`/`knownResourceRevision`), `force`, `openBrowser`, the usage-history filters, `replyToMessageId`, the mailbox page keys, every MCP key (the nested `mutation`/`resolution`/`request` records carry their own revisions and request ids, which every version reads).
- **Capability folding:** none. No command of these domains was gated by a hello capability or a `*_capabilities` command; a node that lacks a newer one answers `unknown-command`, which the callers read (`isUnknownMcpManagementCommandError`, `feature-plan-build-compat.ts`, the accounts fallbacks). Each client's version 0 is today's untyped call answered as sent.
- **Web binding.** `kanban(client)`, `agentMail(client)` on 7003's `backendDomainApi`; `accountsOn(client)(machine)` and `mcpOn(client)(machine)` for the per-machine functions (the client's own node picks its adapter, `withArgumentsObject` keeps `machineInvoke`'s `{}`; another machine, `null` or a node id, is version 0, today's call). The command node's settings target (`invokeCommandNodeSetting`) is a factory client (`commandNodeSettingClient`) for the messaging settings and the account overview, version 0. The portal's routed registry read (`node-environment-reads.ts`) uses `routedBackendClient`, version 0. In suites the command scope has no negotiated domains, so every existing web test runs the version-0 path, today's call.
- **Models box:** ticked with nothing to move. The MCP, mail, accounts and planning results are already protocol types (the schemas type themselves as them). In `models.ts` and `types/index.ts` only the web's `CursorSdkAuthStatus`/`CursorSdkLoginProgress` belong to these domains, and they are narrower (literal unions) than the open schema, so they do not match. The Kanban, notes, feature-plan and Linear records are duplicated between backend `storage-shared-core.ts`/`linear.ts` and web `lib/backend/kanban.ts`, outside those two files: for 7010, with `ProjectUsageLimits` and the Cursor types.
- **Register rows.** None retires or becomes mechanical: no row is served by these domains' commands. Unaffected: backends without `start_feature_plan_build` (renderer fallback; `claim_feature_plan_build` stays registered, now defined), self-reminders in the carrier (renderer reading), bridges older than the MCP configuration report (bridge side), usage limits classified from text (bridge side). New row (this item, below): command nodes without `node-coordinator-mail`. `version-compatibility.md` has a "Kanban, agent mail, accounts and MCP" bullet under Client adapters.
- **Scenario modules** (not yet run live; `mise run qualify:mixed-versions -- --old-version current --scenarios kanban,agent-mail,accounts,mcp` is the control run): `kanban` (ticket created, retried by `requestId`, updated, commented, deleted; notes saved and read; a feature plan created, renamed and listed; each node checked on its own ticket only, since ticket sync copies tickets), `agent-mail` (registry and directory list the fixture worker; the worker's injection set off, the person's mail sent and retried by `requestId`, listed, read, marked seen, acked, in the sent list and the conversations; settings and summary read; injection restored), `accounts` (accounts and idle login listed, switch grant flipped and restored, the auto-switch tick written off only from off, preferred login set and cleared, sign-in and usage reads; never a login, terminal, key or plan-usage read), `mcp` (targets with `protocolVersion`, the backend Pi catalog, a validated HTTP definition saved without applying, read back, removed at its revision, in the run's own temporary HOME). No Linear, GitHub or provider call, no agent turn.
- **Test edits** (outside "unchanged"): `commands-registry-mail.test.ts` faked `listAgentMailConversations` as `{ conversations: [] }`, `getAgentMailConversation` as `{}` and `getAgentMailMessage` as `{ id }`; they now answer the real shapes (result validation in tests refused the fakes). `commands-feature-planning.test.ts`'s planning-service and `updateFeaturePlan` fakes answer real records, and its "rejects unknown fields" asserts stripping. The accounts, usage, Kanban and `commands-integration.test.ts` (`get_plan_usage`) edits each replace an unknown-key refusal with stripping; two accounts cases now check the decode only, because a call that passes would start an OpenCode server or a terminal job. One wording order changed: an accounts call with two wrong fields reports the schema's failure before the platform-support message.
- **Message order restored (2026-11-07).** The order change was not a test edit (no test held two wrong fields); it was behaviour: the decode ran before the handler, so a call with an unsupported platform and another wrong field (`set_agent_account_auto_switch { platform: "grok", enabled: "yes" }`, `set_active_agent_account { platform: "grok", accountId: 1 }`, `get_plan_usage { platform: "blackberry", force: "yes" }`) answered "Expected enabled to be a boolean" where it answered "Agent accounts are not supported for grok" (or "Unknown agent platform: blackberry") before. Options: (a) declare every key checked after the platform `optionalKey(Unknown)` (no contract change for callers, but loses the typed arguments and regenerates the manifest); (b) a platform refinement in the schema (the schema owns the message; changes the manifest and the JSON Schema); (c) run the handler's own first check before the decode. Chosen (c): `asyncHandlerCheckingFirst(first)` in `commands-registry-async-decode.ts` (`ASYNC_HANDLER` plus `first(args)` in `beforeDecode`), used by the seven accounts handlers that check `asAccountPlatform` first (`set_active_agent_account`, `set_agent_account_auto_switch`, `set_coordinator_account_switch_grant`, `rename_agent_account`, `remove_agent_account`, `get_agent_account_usage`, `start_agent_account_login`) and by `get_plan_usage`. Contract unchanged. Tests: `commands-registry-accounts.test.ts` "an unsupported platform is reported before the other fields" (fails on the previous code), `commands-integration.test.ts` `get_plan_usage` with two wrong fields.
- **The other test edits checked (2026-11-07):** the agent-mail fakes now answer `AgentMailConversationList` (`revision`, `conversations`), a conversation and a stored message as `storage-agent-mail.ts` returns them; the feature-planning fakes answer `FeaturePlanningRecord`s, an array for `snapshot` and nothing for `cancel` (`feature-planning.ts`'s signatures), and `updateFeaturePlan` a full plan. Each corrects impossible test data; none changes an expectation about behaviour.
- *(2026-11-07, orchestrator, completeness check: stale; 7009 defined the five in `09d81f2b3`, so the manifest now has 999 defined, 0 untyped, baseline 0.)* **Contract files:** manifest 999 commands (994 defined, 5 untyped), baseline 5 (the four node-mail/ticket-sync neighbours above and `public_action`); `contract:check`, `contract:adapters:check` and `contract:ci` pass on the worktree (the regenerated files may include other items' uncommitted definitions).
- Aggregate suite left to review preparation.
- **Main's new Kanban commands (2026-11-07, rebase onto `main` at `7329d2490`).** #1981 (labels) and #1980 (merged-PR closure) added four string-registered commands; they are defined in `kanban` version 1 (`044a47d02`): `get_kanban_labels` (`workspace`, read; `TicketLabelSummary` model records), `create_kanban_label` (`workspace`; `name`/`color`/`description` `optionalKey(Unknown)`, checked by `parseKanbanLabelInput`; result `{ label: TicketLabelDefinition, created }`), `set_kanban_task_label` (`workspace`; `projectId` critical, the project guard as on `add_kanban_comment`) and `close_kanban_task_for_merged_pr` (`internal`: only the build pipeline's terminal lifecycle calls it, in process; result `{ closed }`). Their `assertOnlyKeys` became the tolerant decode (the label tests assert stripping). `add_kanban_task`/`update_kanban_task` declare `labels`, and `update_kanban_task` `preserveDoneStatus`, both critical (ignored, the labels are silently not written or a pipeline ending moves a done ticket back; the definitions are unreleased, so no bump). `KanbanTaskSchema` types `labels` and `prMergeDoneUrl`. The domain has 33 commands; the client and web binding take them from `KANBAN_COMMANDS`. The scenario module (`scripts/mixed-version/scenarios/kanban.ts`) does not exercise labels yet.

### Finding from 1012: leaf coordinator mail held by an older command node (2026-11-07)

A command node without `node-coordinator-mail` (v2.35.1-beta) collects a current leaf's outbox without `coordinatorMail`, so `LeafNodeMail.collect` skips the leaf coordinator's own mail and `ack` keeps it: `send_coordinator_command_node_mail` answers `placement: "node-outbox"` and the mail waits until that command node is updated. `coordinator.md` said it "arrives as an ordinary worker report", and the register had no row.

- **Option A, deliver it as the doc said** (offer `fromCoordinator` items to an older collect). Pro: the mail arrives. Con: such a command node delivers it as a worker's report from the leaf coordinator's runtime id, an environment it does not have, outside the pair budget that stops two coordinators waking each other (the loop guard #1621 added); a reply to it goes nowhere. It would undo #1621's deliberate filter, whose `deliveryHint` already tells the agent older command nodes keep it queued.
- **Option B, keep the hold, correct the doc, count it** (chosen). Pro: no unbudgeted cross-node wakes, nothing lost, the agent is told; the counter shows when the path can go. Con: the mail waits until the command node updates.
- Done: `LeafNodeMail.collect` records `node-coordinator-mail.older-command-node` (new id in `COMPATIBILITY_PATH_IDS`) on each collect without `coordinatorMail` that holds one; `coordinator.md` "Older nodes" now describes the hold; a register row "Command nodes without `node-coordinator-mail`" (unaffected by the `node-mail` domain: the leaf reads the command node's collect keys). Test: `node-mail.test.ts` "an older command node (no coordinatorMail) is not offered the coordinator's mail; it is held and counted" (held through an older collect and ack, counted once per holding collect, collected once the node asks with `coordinatorMail`). 1012's NM-06 already asserts the hold.

### For the orchestrator (2026-11-07)

- The accounts fork's edit script truncated the worktree's `apps/backend/src/core/commands-registry-projects.ts` while 7005 and 7009 had uncommitted hunks in it; it was restored from HEAD plus its own hunks and the owning agent re-applied theirs. Ask 7005 and 7009 to confirm nothing of theirs is missing. (This agent hit the same script bug once on `client-adapters.ts`; it was restored byte-identical, blob `baa47c404`, before anything else ran.)
- Assign the five remaining untyped commands (Scope above). *(2026-11-07, orchestrator, completeness check: done by [7009](7009-domain-coordinator-servers-system.md), `09d81f2b3`.)*

## Work log

- 2026-11-07 (claude-worker): the four domains converted and committed in slices: `7ff7d4304` (held-mail finding: counter, doc, register row, test), `a4423a0c3` (kanban and agent-mail domains, four subpaths), `df273cf04`/`67236e488`/`3530e2f1b` (kanban: definitions and client; handlers, map, manifest; web and scenario), `06bbc87e5`/`eaa61268b`/`815683859` (accounts: same three slices), `b600a9ce1` (mcp end to end; kanban, accounts and mcp in `DOMAIN_CLIENTS` and `SCENARIOS`), `81d6e6fda` (agent-mail end to end; manifest, baseline and adapters regenerated), and this commit (docs bullet, scope-proof harness on the kanban client, this file). Tests: protocol domain suites and `client-adapters.test.ts` 74 pass; backend Kanban, feature-planning, accounts, usage, mail, MCP, node-mail, switch-grant, coordinator-node-tickets and agent-registry suites 148 pass, plus the mail-adjacent Control MCP, node-coordinator, public-api, gateway and integration suites (failures there belong to other items' in-progress definitions: Control MCP tool schemas, pipelines, config); web domain tests and `agent-accounts.test.ts` 28 pass, the mail, MCP settings and harness suites pass. Protocol, backend and web typecheck clean in these files; `bun fmt` and oxlint clean; `contract:check`, `contract:adapters:check`, `contract:ci` pass. Scenario modules typecheck (`tests/tsconfig.json`); not run live.
- 2026-11-07 (claude-worker): accounts message order restored (the platform check runs before the decode, `asyncHandlerCheckingFirst`), tests for two wrong fields; the remaining test edits confirmed as corrected fakes; tests box ticked, status done.
- 2026-11-07 (orchestrator, completeness check): marked the "5 untyped" contract-files note and the "assign the five remaining untyped commands" follow-up done (7009 `09d81f2b3`).
- 2026-11-07 (claude-worker, completeness audit): mixed-version modules run live (1012 Work log): kanban 14/14, mcp 12/12, agent-mail 14/14 everywhere. accounts failed in the first control run (scenario bug: an attached leaf refuses `set_agent_account_auto_switch` by design, naming its command node); the module now checks that refusal on a leaf, then 12/12 in the control and 11/11 in both v2.36.1 topologies (one read the release lacks is skipped by name).
