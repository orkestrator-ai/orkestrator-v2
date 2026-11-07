---
id: 3010
title: "Convert session, terminal session, Claude tmux and agent mail stores"
phase: 3
plan: "§12 Phase 3.4"
status: not-started
depends_on: [3008, 3009]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3010 · Convert session, terminal session, Claude tmux and agent mail stores

- **Report:** [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [3008](3008-terminal-portal-and-artifact-hosts.md), [3009](3009-agent-and-transcript-stores.md) (`claudeTmuxStore` calls `promptDraftStore`)
- **Blocks:** [3013](3013-pane-layout-store.md)
- **Size:** L
- **Track:** S (scopes)

## Stores (verified 2026-11-07)

| Store | LOC | Imperative sites | Notes |
|---|---|---|---|
| `sessionStore` | 458 | 4 | |
| `terminalSessionStore` | 258 | 16/2 | **missing from the report's hot spots**; mostly `components/terminal/TerminalContainer.view.tsx`, which has 32 sites across stores |
| `claudeTmuxStore` | 1,395 | 11/3 | calls `promptDraftStore` 5 times (:426-626); `lib/claude-tmux-client` uses `@/lib/native/backend` |
| `agentMailStore` | 279 | 17/13 | |

## Work

- [ ] Convert the four stores. The terminal transport comes from `scope.client.terminal`.
- [ ] Convert `TerminalContainer.view.tsx` and `PersistentTerminal.tsx` (scan the latter with the parser; grep treats it as binary).
- [ ] `claudeTmuxStore` calls the scope's `promptDraftStore`, not the shim.

## Tests

- [ ] A terminal on node B uses B's terminal transport, and terminal input sequencing is per node.
- [ ] Existing terminal and tmux suites pass.

## Done when

- [ ] All four stores are converted, and `TerminalContainer.view.tsx` has no shim calls.
