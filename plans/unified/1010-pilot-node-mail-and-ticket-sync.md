---
id: 1010
title: "Pilot domains: node mail, node files and ticket sync"
phase: 1
plan: "§12 Phase 1.5"
status: done
depends_on: [1003, 1004, 1005, 1009]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 1010 · Pilot domains: node mail, node files and ticket sync

- **Report:** [§12 Phase 1](../../docs/reports/unified-federation.md#12-migration-plan), [§11.5](../../docs/reports/unified-federation.md#115-expected-effect-on-the-register)
- **Depends on:** [1003](1003-backend-register-overload.md), [1004](1004-hello-domains.md), [1005](1005-typed-incompatibility-errors.md), [1009](1009-domain-clients-and-adapters.md)
- **Blocks:** [1012](1012-mixed-version-qualification.md), all Phase 7 items
- **Size:** M
- **Track:** C (contract)

## Goal

Prove the whole contract end to end on small domains that are already strict. That means definitions, negotiation, envelope, critical fields, legacy adapter, manifest, CI, and register rows retired or made mechanical.

## Current state (verified 2026-11-07)

Commands in `apps/backend/src/core/commands-registry-nodes.ts` (67 commands; 66 use `assertOnlyKeys`) that belong to the pilot:

- `deliver_node_mail` (:241; keys include `steer`, `turnOrigin`, `projectId`, `attachments`)
- `get_node_project_coordinator` (:293), `get_worker_request_state` (:299), `record_node_environment_origin` (:320)
- `collect_node_outbox` (:329), `ack_node_outbox` (:356), `return_node_outbox_mail` (:395)
- `create_node_action_request` (:406), `list_node_action_requests` (:488), `resolve_node_action_request` (:493)
- `stat_node_file` (:514), `read_node_file` (:519)
- `begin_node_file_write` (:529), `append_node_file_write` (:540), `commit_node_file_write` (:548), `abort_node_file_write` (:553)
- `transfer_node_files` (:615), `list_node_transfers` (:634)

`commands-registry-ticket-sync.ts` (all strict): `apply_ticket_sync` (:52), `get_ticket_sync_cursor` (:98), `collect_ticket_sync_outbox` (:107), `ack_ticket_sync_outbox` (:116), `get_ticket_sync_status` (~:126), `sync_node_tickets` (:134).

Lenient neighbours:

- `prepare_node_mail_attachments` (:320) and `place_node_mail_attachments` (:332) in `coordinator-mail-attachments.ts`
- `send_coordinator_command_node_mail` in `coordinator-node-coordinator-mail.ts`
- `coordinator_node_ticket` in `coordinator-node-tickets.ts`

Capability gating on the sender side, which becomes adapters or critical fields:

- `commands-registry-coordinator-nodes.ts:180` (`supports`), :636 `nodeMailTurnOrigin`, :692 `nodeCoordinatorMail`, :752 `nodeMailSteer`, :971 `nodeCoordinatorBuildOrigin`
- `coordinator-mail-attachments.ts:427` `nodeMailAttachments`
- `nodes/node-mail-collector.ts:162` `coordinatorNotices`, :275 `nodeMailReturn`
- `nodes/node-ticket-sync.ts:260, 389`
- `coordinator-node-tickets.ts:77, 306` `ticketSync`
- `node-link.ts:366`, `node-service.ts:1493` `nodeAttachment`

These are mostly **backend to backend** calls, so the pilot's adapters live in the backend sender, not in the web client.

## Work

- [x] Define the domains `node-mail` (mail, outbox, action requests, attachments), `node-files` and `ticket-sync` in `packages/protocol/src/contract/domains/`. Each starts at version 1, with min 1.
- [x] `defineCommand` for each command above. Args schemas match today's `assertOnlyKeys` sets.
  - `critical`: `steer` on `deliver_node_mail`, plus any idempotency or safety key the handler relies on. Record the reasoning per field in Notes.
- [x] Convert the handlers to `register(def, handler)`. Strict handlers become tolerant with critical fields (§11.4).
- [x] Sender side (`node-link`, coordinator node mail, ticket sync and file transfer callers):
  - use `createDomainClient` with the peer's negotiated `domains`;
  - add a version-0 adapter that keeps today's capability checks for pre-contract peers;
  - delete a capability check only where the version-1 path replaces it.
- [x] Retire or mark mechanical the register rows for these domains (§11.5 counts 9). Update `version-compatibility.md` per row, keeping each row's counter until its retirement condition is met. (7 rows are in these domains: 6 made mechanical, 1 already detected by shape; none can retire yet. See Notes.)
- [x] Regenerate the manifest ([1006](1006-contract-manifest-generator.md)) and adapters list ([1009](1009-domain-clients-and-adapters.md)).

## Tests

- [x] Current↔current, current↔pre-contract fixture peer (capability-gated paths), and a peer that refuses a critical field (typed error surfaced to the coordinator).
- [x] Existing node mail, outbox, ticket sync and file transfer suites pass unchanged. (Pass; the only edits are the one test that pinned the strict refusal this item removes, two raw test registrars wrapped in `registrarFrom`, and two 1009 tests that assumed no client was listed. See Notes.)

## Done when

- [x] The pilot domains are negotiated, adapted and CI-checked.
- [x] A live two-profile node mail and ticket sync run passes, or is listed as needing live evidence. (Passed 2026-11-07 through 1012; see Work log.)

## Notes

### Where Effect is used (2026-11-07)

- **Effect Schema** for every definition: the 24 commands' `args` and `result` (`contract/domains/{node-mail,node-files,ticket-sync}/commands.ts`) and the shared `NodeActionRequestSchema`/`NodeTransferReceiptSchema`, following 1001's rules (`Schema.Int`/`Schema.Finite`, `optionalKey`, no transformations).
- **`effect/Result`** only through 1002's `decodeCommandArgs`/`decodeCommandResult`, which the registry (1003) and `createDomainClient` (1009) already read.
- **Deliberately not Effect:** the three domain clients and the backend glue (`nodes/node-domain-clients.ts`) are promise-based adapters over 1009's `createDomainClient`, for the reason 1009 gives (synchronous selection; callers are promise-based; no services, scopes or fibers). The incompatibility refusals are 1002's `Data.TaggedError`s (`unsupportedField`, `unknownCommand`).

### Decisions (2026-11-07)

- **Commands defined: the 24 strict ones**, exactly the "belong to the pilot" list. The lenient neighbours (`prepare_node_mail_attachments`, `place_node_mail_attachments`, `send_coordinator_command_node_mail`, `coordinator_node_ticket`) stay string-registered in their domains (`contract-domain-map.ts`): they parse leniently (coercions, defaults), and a schema would refuse some value they accept today, which §11.4 forbids. They move with Phase 7 (7008). Converting a strict handler only drops `assertOnlyKeys`; its own checks stay.
- **Argument schemas** declare exactly the former `assertOnlyKeys` keys (pinned by `pilot-domains.test.ts`). A value the handler or its service already checks with its own message (`parseNodeFileScope`, the non-negative integer checks, `parseTicketSyncItem`, `isBackendId`) is `optionalKey(Unknown)`, so the error text is unchanged; plain values the handler passed through as strings or booleans are typed `optionalKey(String/Boolean)`. All are optional, because the handlers decide what a missing key means. One quirk: an empty `Schema.Struct({})` (`list_node_transfers`) passes its input through instead of stripping it; that handler reads nothing.
- **Result schemas have optional fields** for everything that crosses the node link: a pre-contract leaf answers less (older leaves do not report `placement`), fakes in tests answer `{}`, and `decodeCommandResult` drops undeclared keys, so each field a caller reads is declared. Nested data the caller parses itself (`items` of both outboxes, `attachments`, ticket node states) is `Array(Unknown)`. Command-node-local results (action requests, transfer receipts) declare only the fields every record has; converging the full records with the renderer's models is 7010.
- **Critical fields**, per field:
  - `deliver_node_mail.steer`: ignoring it silently does not steer the worker (§11.2).
  - `deliver_node_mail.requestId`: the leaf's idempotency key (`node:<controller>:<requestId>` receipt); a receiver ignoring it would deliver a retry twice.
  - `deliver_node_mail.nodeParent`: carries the hop count that stops two coordinators waking each other.
  - `deliver_node_mail.attachments`: ignoring it delivers the mail without its images.
  - `begin_node_file_write.sha256`: the destination verifies the file against it before it appears. (`overwrite` is not critical: ignoring it falls back to refusing to replace, which is safe.)
  - `apply_ticket_sync.reset`/`liveIds`: a full resync drops replicas the source no longer has; ignoring them would keep deleted tickets.
  - `create_node_action_request.requestId`: a retried request must replay the first, not ask twice.
  - Not critical: `turnOrigin` (the register row: an older leaf frames mail as before, nothing weakens), the outbox flags (`coordinatorMail`, `coordinatorNotices`, `attachmentMail`: a receiver ignoring one keeps that mail queued, which is safe), `ack_node_outbox.sequences` (older leaves already take only `upTo`).
- **`access`**: leaf-side commands called over the link are `internal`; the command node's own user commands (`list`/`resolve_node_action_request`, `transfer_node_files`, `list_node_transfers`, `get_ticket_sync_status`, `sync_node_tickets`) are `admin`, since every pilot command is workspace-excluded (`isWorkspaceExcludedCommand`). **`read`** equals `isNodeReadCommand(name)` (so `stat_node_file` stays `false`), pinned by the test, so routing and the manifest agree.
- **Domain clients** (`contract/domains/<domain>/client.ts`, listed in `DOMAIN_CLIENTS`, `adapters.json` regenerated): `nodeMailClient` (`supports(feature)`, `deliver`, `projectCoordinator`, `collectOutbox`, `ackOutbox`, `returnOutboxMail`), `ticketSyncClient` (`syncs`, `collectOutbox`, `ackOutbox`, `cursor`, `apply`), `nodeFilesClient` (`stat`, `read`, `beginWrite`, `appendWrite`, `commitWrite`, `abortWrite`). Each has adapters 1 and 0. **Version 1 includes every capability that gated these commands** (`NODE_MAIL_FEATURES`: `node-mail-steer`, `node-mail-turn-origin`, `node-coordinator-mail`, `coordinator-notices`, `node-mail-attachments`, `node-mail-return`; and `ticket-sync`), since every build that advertises the domain has them, so `supports()`/`syncs` answer `true` and the capability checks are gone for those peers. **Version 0** reads the hello `capabilities` as before; it leaves out the keys a pre-contract leaf would refuse (`turnOrigin`, the three outbox flags), and refuses (rather than drops) `steer`/`attachments` without their capability with the typed `unsupported-field`, and `return_node_outbox_mail`/ticket-sync calls with `unknown-command`, which is what a node would answer. The senders still check `supports()` first with their own messages and counters; the refusals are a safety net.
- **Backend glue** (`nodes/node-domain-clients.ts`): `peerDomainClient` binds a client to a peer's hello (`domains`, and `capabilities` as a set memoised per hello object so the per-generation cache holds) with `backendDomainAdapterUsage`; `linkDomainApi(link, def)` keeps one client per link and domain (the mail collector, ticket sync, the notice bridge); `routedDomainApi(def, hello, route)` builds one per routed call, because `invoke_on_node`'s routing carries a request key per call (the coordinator tools, file transfers). Selection is an identity check, so per-call building costs nothing.
- **Envelope transport.** 1009's note: `contractEnvelopeFor` sends the definition's own version. The domain clients now pass the envelope they picked: `NodeLink.invoke(command, args, { envelope })`, `NodeLink.invokeCommand(def, args, { envelope })` (an explicit `envelope: undefined`, the legacy adapter, sends today's body; without the option it still falls back to `contractEnvelopeFor`), `RoutableLink.invoke`'s third parameter, `routeToNode({ envelope })` and `NodePortal.invokeOnNode(args, { envelope })` (a second parameter, so a client's `invoke_on_node` can never set it).
- **Senders converted:** `NodeMailCollector` (collect/ack flags, notices, hand-back), `NodeTicketSync` (sync and status), `coordinator-node-tickets.ts` (`syncs`, `prepareRemoteBuildTicket` through the target's new `syncsTickets()`), `send_coordinator_node_mail` (worker mail with `steer`/`turnOrigin`, coordinator mail and its images), `sendToNodeCoordinator`/`nodeCoordinatorMailbox`, `assertNodeTakesMailAttachments`, the auto-switch notice bridge (`index.ts`, through the same `leafTakesCoordinatorNotices` the collector uses, so a notice goes one way only), and `NodeFileTransfer` (new `filesFor` option; `NodeProjectFiles.filesFor` routes another node through `nodeFilesClient` and runs this node's own commands locally). `CoordinatorNodeTarget` gained `nodeMail(requestKey?)` and `syncsTickets()`.
- **Left as string invokes:** `record_node_environment_origin` (`recordOrigin`) and `get_worker_request_state` (`NodeCoordinatorRemote`'s routed read helper), which had no capability gating and whose test fakes answer nothing; the defined handlers accept both forms, so they can move to the client later without a version change. The action-request commands are called in-process only. The `node-attachment` checks (`node-link.ts`, `node-service.ts`) gate `attach_controller` in the `nodes` domain, and `node-coordinator-build-origin` gates pipeline admission (`pipelines`/`coordinator`), so neither is a pilot path.
- **Register rows (§11.5's 9 was an estimate).** Seven rows are in these domains. Six are now mechanical, each keeping its counter and adding `domain-adapter.backend.<domain>.v0`: `node-mail-turn-origin`, `node-coordinator-mail`, `node-mail-attachments` (command node side), `node-mail-return`, `ticket-sync`, and leaves without `coordinator-notices`. The seventh, command nodes without `coordinator-notices`, is the leaf reading the command node's request shape; nothing in it changed, and a current command node always sends the key. None retires yet: every release in the window is a pre-contract peer that still takes these paths; each row now also names the adapter's retirement (the floor passing the first Stable release that advertises the domain).
- **Test edits** (outside "unchanged"): `node-coordination.test.ts` "other unknown fields are still refused" pinned the strict `deliver_node_mail`; it now asserts the key is dropped and does not steer (§11.4). `coordinator-node-tickets.test.ts` and `coordinator-node-coordinator-mail.test.ts` had raw `(name, handler) => map.set(...)` registrars, which store a definition under the object; wrapped in `registrarFrom` as 1003 did elsewhere. `domain-adapter-usage.test.ts` (1009) assumed no client was listed; it now counts `node-mail@0` and drops `node-mail@1` and unlisted pairs.
- **Docs:** `version-compatibility.md` register rows, the renderer–backend skew paragraph, the transports paragraph, a "Pilot domains" bullet under Client adapters, and "How to add a command" step 2 (the `domains/<domain>/` layout).
- **Shared files** (`node-ticket-sync.ts`, `node-portal.ts`, `node-routing.ts`, `index.ts`, `package.json`, the manifest): by commit time the other items had committed their hunks, so each file's diff from HEAD was this item's alone (checked hunk by hunk) and the commit used the pathspec form. 7011 had swept part of this item's `node-ticket-sync.ts` into its commit and restored it in 9e265dfe1; this item's commit (774d06427) carries it.
- Pre-existing, not this item: `commands-registry-nodes.test.ts` "successful portal layout mutation publishes the authoritative stored revision" expects the string event name, while 7011's typed emit passes the definition.
- Aggregate suite left to review preparation.

### The lenient neighbours defined (2026-11-07, from 7009)

The four commands this item left string-registered are defined, which brings the untyped baseline to 0 (with `public_action`, 7009's Notes).

- **Definitions** (`contract/domains/node-mail/commands.ts`: `prepareNodeMailAttachmentsCommand`, `placeNodeMailAttachmentsCommand`, `sendCoordinatorCommandNodeMailCommand`; `contract/domains/ticket-sync/commands.ts`: `coordinatorNodeTicketCommand`), all version 1, `since: 1`, in `NODE_MAIL_COMMANDS`/`TICKET_SYNC_COMMANDS`. Registered with `register(def, handler, ASYNC_HANDLER)` in `coordinator-mail-attachments.ts`, `coordinator-node-coordinator-mail.ts` and `coordinator-node-tickets.ts`; their `contract-domain-map.ts` entries are gone (the map is now empty).
- **Arguments stay lenient, as decided above:** every key the handler reads is `optionalKey(Unknown)` (`to`/`attachments`; `scope`/`requestId`/`subject`/`body`/`replyToMessageId`/`attachments`; `scope`/`nodeId`/`action`/`input`), so `parseRecipient`, `parseMailAttachmentBatch`, `coordinatorCaller`, `nonBlank` and `asNonBlankString` still give their own text and nothing accepted before is refused. Options were typing the plain-string keys (same "Expected x to be a string" text for some) or `Unknown` throughout; `Unknown` was chosen because the handlers coerce (`subject`/`replyToMessageId` are used only when a non-blank string) and §11.4 forbids refusing what they accept. The only change: an unknown key is dropped instead of reaching a handler that ignored it. `ASYNC_HANDLER` keeps a decode failure (only a critical field this build does not know) a rejection, as the handlers' own failures are.
- **`access`:** `internal` for all four: the receiving end is node-link plumbing (both in `isWorkspaceExcludedCommand`), and the other two are coordinator-tool plumbing called in process by Control MCP (both node-excluded). **`read`:** `false`, equal to `isNodeReadCommand` (pinned by `pilot-domains.test.ts`).
- **Critical:** `send_coordinator_command_node_mail`'s `requestId` (the outbox's idempotency key, `knownRequest`: ignored, a retry queues the mail twice), `attachments` (ignored, the mail goes up without its images) and `replyToMessageId` (ignored, the reply loses its thread and the request stays in the inbox). None on the other three: the attachment keys are required by every version, and `coordinator_node_ticket`'s request ids are inside `input`.
- **Results:** `{ missing: string[] }`, `{ attachments: AgentMailAttachment[] }` (`modelRecord<AgentMailAttachment>()` declaring `name`/`path`, what callers read), the leaf coordinator's mail receipt as an `openRecord` (`outboxSeq`, `toEnvironmentId`, `placement`, `coordinatorDelegationOpened` required; the rest optional), and the ticket answer as an `openRecord` of optional fields (`self`, `ticket`/`tickets` as kanban's `KanbanTaskSchema`/`KanbanTaskListSchema`, `nodeId`, `node`, `synced`, `sync`, `note`).
- **Client:** `NodeMailApi.prepareAttachments` (version 1: the call with the envelope; version 0: `unknown-command` without `node-mail-attachments`, which such a leaf answers). `pushCallerAttachmentsToNode` asks through it (`MailAttachmentNode.nodeMail()` now picks `supports` and `prepareAttachments`; its unused `call` is gone). Left by name, deliberately: `place_node_mail_attachments` (called on this node, or through `projectFiles.invokerFor`, which also serves this node), the command node's own `prepare`/`place` in `NodeCoordination.fetchLeafAttachments` and `placeIncomingAttachments` (local), and the in-process Control MCP calls of `send_coordinator_command_node_mail` and `coordinator_node_ticket` (no node link; Control MCP files were 7014's at the time). No `ticket-sync` client change: `coordinator_node_ticket` has no remote caller.
- **Effect:** Effect Schema only (the definitions and results); nothing else here fits Effect.
- **Tests:** `pilot-domains.test.ts` lists the four with the keys their handlers read and a new case pins them lenient (any value of any key decodes unchanged, `{}` decodes, `internal`); no backend test changed.

## Work log

- 2026-11-07 (claude-worker): protocol: `contract/domains/node-files/domain.ts`; `commands.ts`, `client.ts` and `index.ts` for `node-mail`, `node-files` and `ticket-sync` (7011's `domain.ts` reused unchanged), the three clients in `DOMAIN_CLIENTS`, three `package.json` exports, `pilot-domains.test.ts`. Backend: the 24 handlers on `register(def, handler)`, their domain-map entries removed, `nodes/node-domain-clients.ts`, envelope option on `NodeLink.invoke`/`invokeCommand`, `RoutableLink`, `routeToNode` and `NodePortal.invokeOnNode`, the senders listed in Notes, `leafSyncsTickets`/`leafTakesCoordinatorNotices`/`routedDomainApi` in the nodes barrel. Manifest (999 commands, 27 defined), baseline 996 to 972, 21 stored argument schemas, `adapters.json` (three domains, adapters 1 and 0). `mise run contract:check`, `contract:adapters:check` and `contract:ci` pass. Tests: protocol `src` (pass, incl. `pilot-domains.test.ts`); backend focused set of 101 test files (`src/core/nodes`, `public-api`, the coordinator node, mail, ticket, attachment and file suites, `domain-adapter-usage`, `commands-registry-contracts`, `contract-manifest`, gateway hello/envelope/command-node and node SSH tests: 1982 pass, 1 failure from 7011's typed emit, above); root `contract-ci`, `contract-untyped-ratchet`, `domain-import-boundaries`, `unknown-command-text-guard` (pass). Protocol and backend typecheck (both tsconfigs), oxlint and `bun fmt` clean. Live two-profile check deferred to the live qualification pass (2013/1012).
- 2026-11-07 (claude-worker, 1012): live two-profile check passed. Two `dev:test` profiles (`uf-1012-cmd`, `uf-1012-leaf`; `--fixture --no-agent-credentials --headless --agent-platforms claude`, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, host `ORKESTRATOR_*` variables removed) from a detached worktree at 8ba4e87e9, driven by `bun scripts/qualify-contract-mixed-versions.ts --profiles uf-1012-cmd,uf-1012-leaf --scenarios node-mail,ticket-sync`: attach 1/1, node-mail 8/8 (worker delivery, retry by `requestId`, `deliverNow` steered with the leaf's outcome reported, upward coordinator mail collected from the leaf outbox and acked, v1 with no v0 adapter call), ticket-sync 4/4 (ticket to the leaf under the same id, leaf edit back, board in sync, v1). No agent turn was made. Profiles stopped and reset, worktree removed. The same modules also pass against the published v2.36.1 in both topologies through the v0 adapters (1012's Notes).
- 2026-11-07 (claude-worker, 7009): the four lenient neighbours defined (Notes, "The lenient neighbours defined"): definitions in `node-mail`/`ticket-sync`, handlers on `register(def, handler, ASYNC_HANDLER)`, domain-map entries removed, `NodeMailApi.prepareAttachments` used by `pushCallerAttachmentsToNode`, `pilot-domains.test.ts`, `version-compatibility.md` Pilot domains bullet. Manifest 999 commands, 999 defined, 0 untyped; `contract:check`, `contract:adapters:check` and `contract:ci` pass. Tests: protocol `pilot-domains` and `public-api` 46 pass; backend attachment (nodes, docker, local), leaf-coordinator mail, node tickets, Control MCP node mail and coordinator workflows, node routing and contract manifest suites pass (93 in the first set, the rest in the public-api run). Status unchanged (done).
- 2026-11-07 (claude-worker, 7001 completeness audit): the renderer's calls of this domain's command-node commands joined the clients: `TicketSyncApi.status` (`get_ticket_sync_status`, the Kanban sync strip) and `NodeMailApi.actionRequests`/`resolveActionRequest` (the window's approvals), never capability-gated, today's untyped calls at version 0; `NodeActionRequestSchema` is now an open record (as a plain struct a version-1 decode dropped the kinds' own fields, contrary to its doc comment). `pilot-domains.test.ts` +2. aea47ef22.
