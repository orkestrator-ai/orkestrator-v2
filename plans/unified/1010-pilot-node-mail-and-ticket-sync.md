---
id: 1010
title: "Pilot domains: node mail, node files and ticket sync"
phase: 1
plan: "§12 Phase 1.5"
status: not-started
depends_on: [1003, 1004, 1005, 1009]
blocked_by: ""
owner: ""
branch: ""
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

- [ ] Define the domains `node-mail` (mail, outbox, action requests, attachments), `node-files` and `ticket-sync` in `packages/protocol/src/contract/domains/`. Each starts at version 1, with min 1.
- [ ] `defineCommand` for each command above. Args schemas match today's `assertOnlyKeys` sets.
  - `critical`: `steer` on `deliver_node_mail`, plus any idempotency or safety key the handler relies on. Record the reasoning per field in Notes.
- [ ] Convert the handlers to `register(def, handler)`. Strict handlers become tolerant with critical fields (§11.4).
- [ ] Sender side (`node-link`, coordinator node mail, ticket sync and file transfer callers):
  - use `createDomainClient` with the peer's negotiated `domains`;
  - add a version-0 adapter that keeps today's capability checks for pre-contract peers;
  - delete a capability check only where the version-1 path replaces it.
- [ ] Retire or mark mechanical the register rows for these domains (§11.5 counts 9). Update `version-compatibility.md` per row, keeping each row's counter until its retirement condition is met.
- [ ] Regenerate the manifest ([1006](1006-contract-manifest-generator.md)) and adapters list ([1009](1009-domain-clients-and-adapters.md)).

## Tests

- [ ] Current↔current, current↔pre-contract fixture peer (capability-gated paths), and a peer that refuses a critical field (typed error surfaced to the coordinator).
- [ ] Existing node mail, outbox, ticket sync and file transfer suites pass unchanged.

## Done when

- [ ] The pilot domains are negotiated, adapted and CI-checked. A live two-profile node mail and ticket sync run passes, or is listed as needing live evidence.
