---
id: 4007
title: "Every workspace call goes to the workspace's node, with a guard"
phase: 4
plan: "§5.2, §7.3, §7.6 and §12 Phase 4"
status: not-started
depends_on: [4001]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 4007 · Every workspace call goes to the workspace's node, with a guard

- **Report:** [§5.2 The React shape](../../docs/reports/unified-federation.md#52-the-react-shape), [§7.3 shim and ratchet](../../docs/reports/unified-federation.md#73-the-migration-shim-and-its-ratchet), [§7.6 Lint boundaries](../../docs/reports/unified-federation.md#76-lint-boundaries)
- **Depends on:** [4001](4001-in-tree-workspace-seam.md)
- **Blocks:** [4006](4006-multi-node-qualification.md) (feature parity for an in-tree leaf)
- **Size:** M
- **Track:** S (scopes)

## Goal

An in-tree leaf workspace sends every command to its own node. Today the store shims are at zero, but components and hooks inside the workspace subtree still import command-bound `@/lib/backend` exports, which always reach the command node.

## Current state (verified 2026-11-07)

Found while doing [4001](4001-in-tree-workspace-seam.md):

- A heuristic scan (`output/agent-testing/4001/command-bound-survey.py`, not committed) flags about 88 workspace component and hook files that call command-bound `@/lib/backend` exports. Some are false positives.
- No guard catches them. `lib-backend-command-default` ([3002](3002-lib-backend-client-parameter.md)) covers only modules that define scoped state; [4004](4004-runtime-shim-guard.md) sees only store shims.
- Two areas were deferred as wholes by 4001:
  - the design canvas: all of `designApi` and its helpers, which must move together so one canvas never splits its operations across two nodes;
  - `lib/claude-tmux-client.ts` (about 20 functions) and leaf prompt-queue restore, which depends on it.
- `backendForScope(scope)` (`lib/backend/scope-backend.ts`, 4001) gives every backend function for one node, and is the module itself on the command scope, so existing mocks keep working.

## Work

- [ ] A shrink-only source guard `workspace-command-bound-call`: inside the workspace import graph (from `WorkspaceContent`/`ProjectWorkspace`, as 3013 traced it), count uses of command-bound `@/lib/backend` exports. Window-level and command-only modules are exempt and listed.
- [ ] Convert every flagged file to its scope's backend (`backendForScope(useShimNodeScope(...))`, `backendApiForScope`, or the domain clients), until the guard's baseline is zero for the workspace graph.
- [ ] Move the design canvas's `designApi` calls and helpers to the canvas's scope, together.
- [ ] Bind `lib/claude-tmux-client.ts` to a scope, with a per-scope event listener; restore a leaf's prompt queues from the leaf.

## Tests

- [ ] For a representative component in each area (agent tab, terminal, files, previews, design, tmux, mail, Kanban, PRs), rendered in a leaf scope, every command reaches the leaf's fake client and none reaches the command client.
- [ ] The guard's baseline is committed and fails on a new command-bound call in the workspace graph.

## Done when

- [ ] The guard's baseline is zero for the workspace graph, and the representative tests pass.

## Notes

- 2026-11-07 (orchestrator): created from 4001's finding. Without it, an in-tree leaf would send part of its traffic to the command node, so 4006's parity check depends on it.

## Work log
