---
id: 0006
title: "Live evidence for the workspace grant command scope (todo 5740)"
phase: 0
plan: "§10.2 and §12 Phase 6.5"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 0006 · Live evidence for the workspace grant command scope (todo 5740)

- **Report:** [§10.2](../../docs/reports/unified-federation.md#102-tighten-the-grant-command-list)
- **Todo:** [5740](../../docs/todo/cross-cutting/5740-workspace-grant-scope-live-evidence.md), tasks 1 and 2
- **Depends on:** none
- **Blocks:** [6001](6001-in-tree-by-default.md) and [7012](7012-allow-listed-grants.md)
- **Parallel with:** everything
- **Size:** S (live qualification)
- **Track:** F (fixes now)

## Goal

Prove between two real backends that a workspace grant (direct and relayed) keeps every workspace feature and is refused administration. That proof is the baseline the allow-list in [7012](7012-allow-listed-grants.md) must reproduce.

## Current state (verified 2026-11-07)

- `NODE_EXCLUDED_COMMANDS` is in `apps/backend/src/core/nodes/node-routing.ts:24-144`, not in `workspace-grant-scope.ts` as the report says.
- `WORKSPACE_ADMINISTRATION_COMMANDS` is in `apps/backend/src/core/nodes/workspace-grant-scope.ts:16-56`. The fail-open warning is at :13-14.
- `isWorkspaceExcludedCommand` (`node-routing.ts:152-199`) combines both lists with an inline list of link and controller plumbing.
- Grant refusal: `gateway-auth.ts:507-508` → 403 in `gateway-handlers.ts:110-126`. Relay refusal: `node-relay.ts:200-221`.
- Unit coverage: `apps/backend/tests/gateway-workspace-grant-scope.test.ts`, `apps/backend/src/core/nodes/workspace-grant-scope.test.ts`.

## Work

- [ ] Task 1 of 5740: two `dev:test` profiles, one attached to the other, driven with Playwright.
  - Through the browser realm, once with a direct grant and once with the relay forced:
    - open a leaf environment;
    - run a terminal command;
    - open the agent tab without sending a turn;
    - open the agent and usage popovers, repository settings and the project boards.
  - Confirm that the leaf log has no `This credential cannot run that command.` refusal.
  - POST `update_global_config` and `request_host_update` with the grant and through the relay, and expect 403.
- [ ] Task 2 of 5740: a v2.35.1-beta command node (installed into a throwaway data directory; never the real data directory or ports 34121/34122) attached to a current leaf. Favourite a model in the leaf's realm and read `get_compatibility_path_usage` on the leaf.
- [ ] Update 5740 with the results, following the todo format rules. Close it if both pass.
- [ ] Record the full list of commands a realm actually sent during task 1 (names only), to seed the `access: "workspace"` classification in [7012](7012-allow-listed-grants.md).

## Done when

- [ ] Both tasks pass, or the refused commands found are fixed with a regression test.

## Notes

- No billed provider turns unless the user authorises them.
