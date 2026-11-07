---
id: 5001
title: "Attention, sounds and notifications from one window service"
phase: 5
plan: "§9 Attention and §12 Phase 5.1"
status: not-started
depends_on: [4001, 0002]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 5001 · Attention, sounds and notifications from one window service

- **Report:** [§9](../../docs/reports/unified-federation.md#9-cross-node-features), [§8.4](../../docs/reports/unified-federation.md#84-inactive-path-behaviour)
- **Depends on:** [4001](4001-in-tree-workspace-seam.md), [0002](0002-attention-without-realm.md)
- **Blocks:** [6001](6001-in-tree-by-default.md)
- **Parallel with:** [5002](5002-pr-opener-and-title-bar.md), [5003](5003-settings-bug-report-shortcuts-dialogs.md), [5004](5004-coordinator-and-portal-through-command-scope.md)
- **Size:** S–M
- **Track:** S (scopes)

## Goal

Every node alerts exactly once, whatever its tier, and a click opens that node.

## Current state (verified 2026-11-07)

- `useNotificationSoundService.ts` listens locally (:193). [0002](0002-attention-without-realm.md) adds relayed subscriptions for nodes without a realm.
- `lib/question-desktop-notification.ts:58-70` (`openEnvironment`, called from the click handler at :107-112) selects in the creating renderer's own stores, so a click from a realm does not change the shell's active node. This is confirmed from the code, not reproduced.
- Pending approvals and questions for non-live nodes already come through `useRemoteHumanPrompts.ts:118`.

## Work

- [ ] One window service: for warm and live scopes, listen on the scope client; for summary-tier nodes, use `subscribeNodeEvents`. Deduplicate by `(nodeId, attentionId)`, and move a node between sources when its tier changes without a gap or a duplicate.
- [ ] A notification click calls `openMachineWorkspace(nodeId, { projectId, environmentId })`.
- [ ] Remove the per-realm path once [6002](6002-delete-web-realm-code.md) lands; until then, skip realm nodes as [0002](0002-attention-without-realm.md) does.

## Tests

- [ ] Tier change mid-stream: no duplicate and no gap. A click opens the right node and environment from every tier.

## Done when

- [ ] A live check covers attention from a summary-tier node, a warm node and the shown node, with a click opening each.
