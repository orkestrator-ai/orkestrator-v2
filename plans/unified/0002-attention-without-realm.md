---
id: 0002
title: "Attention sounds and notifications for machines without an open realm"
phase: 0
plan: "§1, §9 and §12 Phase 0.2"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 0002 · Attention sounds and notifications for machines without an open realm

- **Report:** [§9 Cross-node features](../../docs/reports/unified-federation.md#9-cross-node-features), [§12 Phase 0](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** none
- **Parallel with:** everything
- **Size:** S
- **Track:** F (fixes now)

## Goal

A machine the window is not showing still makes its attention sound and desktop notification.

## Current state (verified 2026-11-07)

- **The report's proposed fix is wrong.** The node event relay has no allow-list to add attention to.
  - `apps/backend/src/core/nodes/node-event-relay.ts` relays whatever names a client leases through `watch_node_events`.
  - `PORTAL_PREFIXES` (:62-66) is only the portal views' stable subscription set.
  - The only refused names are `UNRELAYABLE_EVENT_PREFIXES` (`packages/protocol/src/node-events.ts:38-41`: `terminal-output-` and `relayed-node-event`).
  - Limits: `MAX_NODE_EVENT_PREFIXES = 32`, `MAX_NODE_EVENT_WATCHES = 256`.
- **The gap is on the client.** `apps/web/src/hooks/useNotificationSoundService.ts` (313 lines, mounted at `App.tsx:345`) listens with the plain `listen()` at :193. So it hears only the window's own node. Each open realm runs the same `ConnectedApp`, so it sounds for its own node. A node with no realm is silent. This is confirmed from the code, not reproduced.
- The event is `ENVIRONMENT_ATTENTION_EVENT = "environment-attention"` (`packages/protocol/src/environment-attention.ts:23`), emitted at `apps/backend/src/core/backend-event-fanout.ts:34`.
- The pattern to copy is `apps/web/src/hooks/useRemoteHumanPrompts.ts:117-137`: one `subscribeNodeEvents(nodeId, {events, onEvent, onResync})` per node (`lib/federation/node-events.ts:261-305`), cleaned up on change.
- Duplicates are deduplicated by `attentionId` (`BoundedKeySet`, :192). That is per renderer, though, so a node with an open realm would alert from both the shell and the realm.

## Work

- [ ] Reproduce the gap first: two `dev:test` profiles, one attached to the other, with no realm open for the leaf. Trigger attention on the leaf and confirm the window is silent. Record the result in Notes.
- [ ] In the shell renderer only (not inside a realm), subscribe to `ENVIRONMENT_ATTENTION_EVENT` per non-command node through `subscribeNodeEvents`. Skip nodes that are in `useRemoteWorkspaceStore.getState().realms`, because the realm already sounds for them.
- [ ] Feed the payloads into the same sound and notification path, keyed by `(nodeId, attentionId)`.
- [ ] Respect the per-node notification settings that already apply to the command node's own environments.

## Tests

- [ ] Hook test: a leaf without a realm alerts once; a leaf with an open realm does not alert from the shell; resubscribes when the realm set changes; unsubscribes on unmount.
- [ ] A resync frame does not replay old attention.

## Done when

- [ ] A live two-profile check shows a sound and notification from a leaf with no realm open, and only one when a realm is open.

## Notes

- [5001](5001-attention-per-scope.md) later replaces this with one window service fed by node scopes. Keep this hook small so it can be lifted unchanged.
- A notification click from a summary-tier node cannot open it in-tree until Phase 4. Until then it opens the realm through `openMachineWorkspace`.
