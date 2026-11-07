---
id: 5001
title: "Attention, sounds and notifications from one window service"
phase: 5
plan: "§9 Attention and §12 Phase 5.1"
status: done
depends_on: [4001, 0002]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] One window service: for warm and live scopes, listen on the scope client; for summary-tier nodes, use `subscribeNodeEvents`. Deduplicate by `(nodeId, attentionId)`, and move a node between sources when its tier changes without a gap or a duplicate.
- [x] A notification click calls `openMachineWorkspace(nodeId, { projectId, environmentId })`.
- [x] Until [6002](6002-delete-web-realm-code.md) lands, skip realm nodes as [0002](0002-attention-without-realm.md) does.
- [x] Remove the per-realm path once [6002](6002-delete-web-realm-code.md) lands. *(Removed in 6002, commit 4312188ab: `realmNodes()` and the `inTreeNodesStore` subscription in `window-attention.ts`, the realm-renderer gate in `useRemoteNodeAttention`, the realm click path in `question-desktop-notification.ts`, and their realm test cases.)*

## Tests

- [x] Tier change mid-stream: no duplicate and no gap. A click opens the right node and environment from every tier.

## Done when

- [x] A live check covers attention from a summary-tier node, a warm node and the shown node, with a click opening each.

## Notes

- **API (2026-11-07).** `apps/web/src/lib/federation/window-attention.ts`:
  - `startWindowAttention({ windowScope, onAttention(nodeId, event, source), handoverTimeoutMs?, schedule? }) → { sourceOf(nodeId), feedsOf(nodeId), stop() }`. One per window scope (starting another stops the first). `AttentionSource = "scope" | "relay"`.
  - `attentionHandoff(windowScope, nodeId): Promise<void>`: for a lifecycle manager about to close a leaf scope's streams; moves the node to the relay while the scope's stream is still open and resolves once the relay is live (at most `ATTENTION_HANDOVER_TIMEOUT_MS`, 10 s). Resolves at once when nothing needs handing off.
  - `shownEnvironmentOn(windowScope, nodeId)`: the shown in-tree node's on-screen environment (the window selection, a project home only on its Home tab), else `null`.
  - `WINDOW_ATTENTION_DEDUPE_LIMIT` (512), `ATTENTION_HANDOVER_TIMEOUT_MS`.
  - `hooks/useRemoteNodeAttention.ts` keeps its name and signature (plus the `source` argument) and now only starts and stops the service in the shell renderer. `remoteAttentionTarget` is unchanged.
- **Sources (2026-11-07).** A node is heard on its scope (`scope.client.listen(environmentAttentionEvent)`) when it has an open leaf scope in tier `warm` or `live` **and** the window's region holds it (it is in `realms` and in-tree). Every other node in the summaries, or with a scope in `suspended`/`summary`, is heard through `subscribeNodeEvents`. Skipped: the window's own node (portal `selfId` and the command scope's id), and nodes shown by a realm renderer (`realms` minus in-tree nodes) until 6002. The service subscribes to `portalStore`, `useRemoteWorkspaceStore`, `useInTreeNodesStore`, `windowScope.nodeScopes` and each leaf scope's `tier` signal, and reconciles per node, so one node's change never touches another's lease.
- **Decision: handover by overlap (2026-11-07).** Options: (a) switch sources at once; (b) keep every non-realm node on the relay always and add the scope on top; (c) subscribe the new source first, keep the old one until the new one is live, dedupe across both. (a) leaves a gap of one lease round trip (relay) or one stream open (scope). (b) has no gap but keeps a relay lease per in-tree node, which the warm tier exists to avoid and 5005 cares about. Chosen: (c). Readiness is the scope client's `eventStreamReady("environment-attention")` or the relay's first `onResync`, bounded by 10 s. One `(nodeId, attentionId)` set (512) for the service's life covers both sources and later returns.
- **Decision: a released scope already moves to the relay (2026-11-07).** When the region lets an in-tree node go, its scope stays open for 4001's grace period. The service moves the node to the relay then, while the scope's stream still delivers, so the later dispose has nothing to hand over. Without this the dispose would close the stream before the relay lease is confirmed.
- **For 4002 (coordination).** The tier signal 5001 consumes is `NodeScope.tier` (already on the branch). In 4002's uncommitted `lifecycle.ts`, `suspend()` calls `client.suspend()` before `move(..., "suspended")`, so the scope's stream closes before this service sees the tier change: attention raised during the relay lease's first round trip would be missed on that path (the warm → suspended timer, document-hidden, pressure). Gap-free: set the tier first, or `await attentionHandoff(windowScope, nodeId)` (bounded) before `client.suspend()`/`dispose()`. The orchestrator should pass this on, or 4002 can take it as a follow-up. A tier change also clears an earlier `attentionHandoff` pin, so a resumed scope is heard on itself again.
- **Decision: the command node stays on the sound service's own `listen` (2026-11-07).** `@/lib/native/events` `listen` is already the command scope's client (plan item 2010), and that path carries the `hasUnreadWork` fallback for backends that predate `environment-attention`. Moving it into the service would change nothing on the wire and churn 28 tests. While another node is shown in the central region, none of the command node's environments counts as on screen (`useRemoteWorkspaceStore.active`), so its "agent stopped" cue is no longer swallowed by a hidden selection.
- **On screen for other nodes.** Only the shown in-tree node has an on-screen environment (`shownEnvironmentOn`); its "agent stopped" cue stays quiet as the window's own selected environment does, and a question there notifies unless the window has focus. A realm node is skipped, and a summary-tier or hidden node is never on screen.
- **Clicks.** A remote notification calls `openMachineWorkspace({ connectionId: nodeId, projectId, environmentId, boardTab: "home" for a project home })` (from 0002). A local one now goes through `openMachineWorkspace` too: in the window with the portal's `selfId` (or the command scope's id), which selects as before (plus expanding the project); in a realm, with the realm's command scope id, which posts `open` to the window so the window's active node follows the click (the "Current state" bug). A realm that has not proven its id yet keeps the old local selection.
- **Effect.** Not used. The service is a reconcile loop over existing signals and two subscription primitives with one timer per handover, all stopped by `stop()`; an Effect `Scope` would add a runtime without simplifying it.
- **Live check (2026-11-07).** Two `dev:test` profiles from a detached worktree of `a061b3a66` (`uf-5001-cmd`, `uf-5001-leaf` attached with `add_node`; `--fixture --no-agent-credentials --headless`, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, inherited `ORKESTRATOR_*` agent variables stripped), headless Chromium on the command profile's `browserUrl`, the leaf flagged in-tree for that window. No provider turn: "agent stopped" attention from `echo` in an activity-tracked terminal (`terminal_finished`, as in 0002), and question attention from a **mock graph run** (`graph_run_mock`, no provider session) of a one-node template whose `human` node is pinned to `pause`: the live human executor opens a wait and `graph-run-attention.ts` lights the badge with `agent_question`. Cues counted by wrapping `AudioContext.prototype.createOscillator`, notifications by a `Notification` stub that keeps its listeners (a click is the stub's `click` listener), `document.hasFocus` false. Relay prefixes recorded from the page's `watch_node_events` requests. Results (`output/agent-testing/5001/5001-live.json`, screenshots `5001-{A,B,C}-*.png`):
  - **Summary tier** (no scope, no realm): `terminal_finished` on leaf-two → 1 cue; a question on leaf-one → 1 cue, 1 notification ("Leaf5001 · origin · leaf-one", tag with the node). Its click opened the leaf **in-tree** (region `data-node` = the leaf, 0 realm frames) with leaf-one shown.
  - **Shown node** (in-tree, live): `terminal_finished` on the on-screen leaf-one → 0 cues; on leaf-two → 1 cue; a question on leaf-two → 1 cue, 1 notification; its click switched the shown environment to leaf-two.
  - **Warm node** (the window's own desk-env shown; the leaf held in-tree, hidden): `terminal_finished` → 1 cue; a question → 1 cue, 1 notification; its click brought the leaf back with leaf-one shown.
  - Relay: the leaf's lease carried `environment-attention` before the first open, dropped it when the leaf opened in-tree, and never added it back while the leaf was shown or hidden-but-held: those alerts came from the scope.
  - 0 realm cues and 0 duplicates in every step.
- Not exercised live: a 4002 tier transition (4002's lifecycle is not on the branch yet); the in-tree scope on the desktop host (`orkestrator:nodes:open`). Both paths are unit tested through the same `NodeScope` API.
- Aggregate suite left to review preparation.
- Seen in passing, not 5001's: with a leaf shown in-tree, the command node's last selected row (desk-env) keeps its selected highlight in the sidebar (`5001-C-click-opened-warm-leaf.png`).

## Work log

- 2026-11-07 (claude-worker): added the window attention service (`lib/federation/window-attention.ts`) and moved `useRemoteNodeAttention` onto it; in-tree leaves on their warm/live scope, everything else on the relay, realm nodes skipped, overlap handover deduplicated by `(nodeId, attentionId)`, `attentionHandoff` for 4002. The sound service treats the shown in-tree environment as on screen and the command node's selection as hidden while another node is shown. Local notification clicks go through `openMachineWorkspace`, so a realm's click moves the window. Tests: `lib/federation/window-attention.test.ts` 13 (sources, tier change mid-stream both ways with no gap and no duplicate, released scope, bounded wait, disposed and reopened scope, handoff, stop, `shownEnvironmentOn`), `hooks/useRemoteNodeAttention.test.tsx` 17 (+2: in-tree leaf alerts once from its scope and its click opens it; the shown in-tree environment is quiet), `lib/question-desktop-notification.test.ts` 9 (+2: realm click posts `open`; provisional id stays local), `useNotificationSoundService.test.tsx` 28 unchanged. Focused web suites `src/hooks src/lib/federation` and `App.test.tsx`: 1173 pass, 3 fail in `in-tree-scopes.test.ts` from 4002's uncommitted edit of `in-tree-scopes.ts`. Web typecheck clean in my files (errors only in other agents' in-progress files), fmt and oxlint clean, source guards clean for my files. Live check passed as in Notes. Commit `0303f0a87`.
- 2026-11-07 (claude-worker, plan item 6002): removed the per-realm path with the web realm code (commit 4312188ab): every node other than the window's own is heard on its warm or live scope or through the relay; nothing is skipped for a realm any more. Last open box ticked; item done.
