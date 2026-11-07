---
id: 3009
title: "Convert the agent and transcript stores, keeping the history budget window-wide"
phase: 3
plan: "§12 Phase 3.4 and §7.4 Byte budgets"
status: not-started
depends_on: [3004, 3016]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3009 · Convert the agent and transcript stores, keeping the history budget window-wide

- **Report:** [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan), [§7.4 Byte budgets](../../docs/reports/unified-federation.md#74-services-and-module-state)
- **Depends on:** [3004](3004-project-and-environment-stores.md), [3016](3016-rich-content-and-caches.md)
- **Blocks:** [3010](3010-sessions-terminals-tmux-mail.md), [3013](3013-pane-layout-store.md)
- **Size:** L
- **Track:** S (scopes)

## Goal

Native agent projections, compose state and prompt drafts are per node. The transcript history byte budget is shared by every node, so per-node instances do not multiply memory (invariant 11).

## Current state (verified 2026-11-07)

| Store | LOC | Imperative sites | Notes |
|---|---|---|---|
| `nativeAgentProjectionStore` | 423 | 18/17 | 33 test files; `historyBytesTotal` at :93-94 is the process-wide budget |
| `nativeComposeStore` | 517 | 52/18 | 13 of the sites are calls on itself |
| `promptDraftStore` | 176 | 9/7 | `claudeTmuxStore` calls it 5 times |

Heavy modules:

- `AgentNativeTab.controller.tsx` (16 sites)
- `AgentNativeTab.tsx` (12)
- `useNativeAgentSession.ts` (12; module-level `syncCapability*` lets at about :129-143)
- `compose-draft-persistence.ts` (207 LOC, 2 singletons)
- `native-session-shared-reads.ts`, `native-observation-events.ts`, `agent-handoff.ts`

## Work

- [ ] Convert the three stores. Replace `historyBytesTotal` with reservations on the window `ByteBudget`, using node-qualified keys and the existing eviction order.
- [ ] Make the capability lets in `useNativeAgentSession.ts` per scope (folded into domain versions in [7001](7001-domain-native-sessions.md)).
- [ ] Turn the module singletons above into scoped services or scope state.
- [ ] Convert `AgentNativeTab*` imperative sites (the scope is always known inside a tab).

## Tests

- [ ] Two nodes' transcripts share one budget: filling it on node B evicts B's or A's least-recently-shown history, never the shown session.
- [ ] Draft persistence is per node.

## Done when

- [ ] All three stores are converted, the agent tab works under the command scope, and the budget test passes.
