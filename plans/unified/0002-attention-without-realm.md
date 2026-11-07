---
id: 0002
title: "Attention sounds and notifications for machines without an open realm"
phase: 0
plan: "§1, §9 and §12 Phase 0.2"
status: done
depends_on: []
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] Reproduce the gap first: two `dev:test` profiles, one attached to the other, with no realm open for the leaf. Trigger attention on the leaf and confirm the window is silent. Record the result in Notes.
- [x] In the shell renderer only (not inside a realm), subscribe to `ENVIRONMENT_ATTENTION_EVENT` per non-command node through `subscribeNodeEvents`. Skip nodes that are in `useRemoteWorkspaceStore.getState().realms`, because the realm already sounds for them.
- [x] Feed the payloads into the same sound and notification path, keyed by `(nodeId, attentionId)`.
- [x] Respect the per-node notification settings that already apply to the command node's own environments.

## Tests

- [x] Hook test: a leaf without a realm alerts once; a leaf with an open realm does not alert from the shell; resubscribes when the realm set changes; unsubscribes on unmount.
- [x] A resync frame does not replay old attention.

## Done when

- [x] A live two-profile check shows a sound from a leaf with no realm open, and only one when a realm is open.
- [x] The same check for the question desktop notification (verified 2026-11-07 without a provider turn; see Notes).

## Notes

- [5001](5001-attention-per-scope.md) later replaces this with one window service fed by node scopes. Keep this hook small so it can be lifted unchanged.
- A notification click from a summary-tier node cannot open it in-tree until Phase 4. Until then it opens the realm through `openMachineWorkspace`.
- Live check (2026-11-07), two `dev:test` profiles (`uf-live-cmd` command node, `uf-live-leaf` attached with `add_node`), headless Chromium on `uf-live-cmd`'s `browserUrl`. Attention was raised on the leaf without a provider turn: clear the environment's unread badge (`set_environment_unread`), then run `echo` in an activity-tracked local terminal (`create_local_terminal_session` with `trackEnvironmentActivity: true`), which lights the badge with `terminal_finished` and emits one `environment-attention`. Cues were counted by wrapping `AudioContext.prototype.createOscillator` per frame (shell vs realm). Results (`output/agent-testing/uf-live/0002-*.json`):
  - Before the fix (`useNotificationSoundService.ts` and `question-desktop-notification.ts` reverted to `acc1e4d81~1` in the live worktree, hot-reloaded): no realm for the leaf, the leaf's badge lit (`terminal_finished`), the window played **0** cues. The gap is reproduced.
  - After the fix: no realm, **1** cue from the shell. With the leaf's realm open but hidden (another environment shown) and attention on a second leaf environment: **1** cue from the realm, **0** from the shell.
- Not done in the first pass (closed later, see the next notes): the question desktop notification. Only `agent_question`/`agent_waiting` raise it; the first pass assumed both need a provider turn.
- A second leaf environment was used for the realm-open case, because the realm's selected environment (on screen in the realm) clears its own badge, so attention on it does not light.
- Implemented in `apps/web/src/hooks/useRemoteNodeAttention.ts`, called from `useNotificationSoundService`. It subscribes every node in the portal summaries except the command node itself and the nodes in `realms`, diffing per node so one realm opening or closing does not churn the other nodes' leases. It is off in a realm renderer (`isWorkspaceRealm()`). `onResync` reads nothing. Dedupe is a `BoundedKeySet` (256) of `nodeId + attentionId` that lives as long as the hook, so a realm that opens and closes does not replay old attention.
- Settings: the shell applies its own `config.global.notificationSounds` (`agentStopped`, `agentQuestion`, `questionDesktopNotification`), the same settings that apply to the command node's own environments. Cues coalesce with the command node's own cues (`claimCue`). A remote environment is never "on screen" in the shell, so the visible-environment check does not apply.
- Notification click: `showQuestionDesktopNotification` takes an optional `remote` `{ nodeId, label, open }`. The label (machine · project · environment) comes from the node summary. The click opens the realm through `openMachineWorkspace`. The tag includes the node id.
- A node with no realm whose backend predates `environment-attention` stays silent. There is no remote `hasUnreadWork` fallback.
- When a realm opens, the shell drops that node at once, before the realm has subscribed. Attention raised in that short gap is not heard. This is acceptable for a cue that is not state.
- **Question notification, live (2026-11-07, during [5001](5001-attention-per-scope.md)).** An `agent_question` attention needs no provider turn: a mock graph run (`graph_run_mock`, no provider session, no side effects) of a one-node user template whose `human` node is pinned to `pause` goes to the live human executor, which opens a wait; `graph-run-attention.ts` records it and lights the environment's badge with `agent_question` once, which emits one `environment-attention`. Script: `output/agent-testing/5001/scripts/trigger.ts` (`question(environmentId)`). Two `dev:test` profiles (`uf-5001-cmd`, `uf-5001-leaf` attached), browser path, realms only (no in-tree node), `Notification` stubbed per frame, `document.hasFocus` false. Results (`output/agent-testing/5001/0002-question-live.json`): no realm for the leaf → **1** notification, from the shell ("Leaf5001 · origin · leaf-one", tag with the node id), 1 cue. The leaf's realm open but hidden (the window's own environment shown), question on another leaf environment → **1** notification from the realm, **0** from the shell. Clicking the realm's notification now moves the window to the leaf with that environment shown (5001's `openMachineWorkspace` click), `0002-question-realm-click-opened.png`.
- Effect was not used. It is a small React hook over existing subscription primitives, and Effect would not make it simpler.

## Work log

- 2026-11-07 (claude-worker): added `useRemoteNodeAttention` (per-node `subscribeNodeEvents` for nodes without an open realm, shell only, `(nodeId, attentionId)` dedupe, no replay on resync) and wired it into `useNotificationSoundService`. The agent-stopped cue, the agent-question cue and the question desktop notification use the existing settings. `question-desktop-notification.ts` gained an optional `remote` target, so a remote question is named from the node summary and its click opens the realm. Tests: `apps/web/src/hooks/useRemoteNodeAttention.test.tsx` (15 pass), `useNotificationSoundService.test.tsx` (28 pass, unchanged), `question-desktop-notification.test.ts` pass, `src/App.test.tsx` + `src/hooks` pass. Web typecheck clean, oxlint clean. Live reproduction deferred to the wave-0 live-evidence pass.
- 2026-11-07 (claude-worker, live evidence): reproduced the gap live with the fix reverted (0 cues), then confirmed the fix live (1 cue from the shell with no realm; 1 from the realm and 0 from the shell with the realm open). Question notification not exercised (needs a provider turn); that half of Done-when left open.
- 2026-11-07 (claude-worker, during 5001): closed the question-notification half of Done-when live without a provider turn (mock graph run paused at a human node), as in Notes. Status done.
