---
id: 7012
title: "Derive the grant allow-list from the manifest and fail closed"
phase: 7
plan: "§10.2 and §12 Phase 7"
status: in-progress
depends_on: [7001, 7002, 7003, 7004, 7005, 7006, 7007, 7008, 7009, 0006]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 7012 · Derive the grant allow-list from the manifest and fail closed

- **Report:** [§10.2 Tighten the grant command list](../../docs/reports/unified-federation.md#102-tighten-the-grant-command-list)
- **Depends on:** every Phase 7 domain item ([7001](7001-domain-native-sessions.md) to [7009](7009-domain-coordinator-servers-system.md)) and [0006](0006-grant-scope-live-evidence.md)
- **Size:** M
- **Track:** C (contract), security

## Goal

A workspace grant can run exactly the commands whose definition says `access: "workspace"`. A new command is refused through a grant until it declares otherwise.

## Current state (verified 2026-11-07)

- The deny-lists:
  - `NODE_EXCLUDED_COMMANDS` (`apps/backend/src/core/nodes/node-routing.ts:24-144`);
  - `WORKSPACE_ADMINISTRATION_COMMANDS` (`workspace-grant-scope.ts:16-56`, which warns that it fails open);
  - the inline list in `isWorkspaceExcludedCommand` (`node-routing.ts:152-199`).
- Enforcement points: grants (`gateway-auth.ts:507-508` → `gateway-handlers.ts:110-126`) and the relay (`node-relay.ts:200-221`).
- `invoke_on_node` routing is a different path and is unaffected by the grant lists.

## Work

- [ ] Prove equivalence before switching. A test computes the allow-list from the manifest (`access === "workspace"`) and compares it with today's effective set (every registered command minus `isWorkspaceExcludedCommand`). Any difference must be justified in Notes, command by command.
- [ ] Switch grant and relay refusal to "not in the allow-list", failing closed. Keep the old function as a debug-only cross-check for one release, logging content-free disagreements.
- [ ] Delete `NODE_EXCLUDED_COMMANDS`, `WORKSPACE_ADMINISTRATION_COMMANDS` and the inline list once nothing reads them. Keep the separate `invoke_on_node` exclusions if they still serve routing, renamed for that purpose.
- [ ] Re-run [0006](0006-grant-scope-live-evidence.md)'s live checks against the new list.
- [ ] Update `docs/architecture/command-nodes.md` and `renderer-security.md`.

## Tests

- [ ] An unregistered or undefined command is refused through a grant and the relay. Every `workspace` command is admitted. Every `admin` and `internal` command is refused.
- [ ] Existing grant-scope tests pass.

## Done when

- [ ] Grants fail closed in production, and the deny-lists are gone.
