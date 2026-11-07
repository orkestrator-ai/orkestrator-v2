---
id: 3013
title: "Convert paneLayoutStore and its persistence services (last)"
phase: 3
plan: "§12 Phase 3.6"
status: not-started
depends_on: [3006, 3007, 3008, 3009, 3010]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3013 · Convert paneLayoutStore and its persistence services (last)

- **Report:** [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [3006](3006-ui-store-split.md), [3007](3007-files-panel-split.md), [3008](3008-terminal-portal-and-artifact-hosts.md), [3009](3009-agent-and-transcript-stores.md), [3010](3010-sessions-terminals-tmux-mail.md)
- **Blocks:** [4001](4001-in-tree-workspace-seam.md)
- **Size:** L
- **Track:** S (scopes), critical path

## Goal

The largest and most connected store is per node. After this item, the workspace subtree has no shim calls.

## Current state (verified 2026-11-07)

- `paneLayoutStore`: 1,852 LOC; 88 imperative sites, 45 of them in `.ts`; 40 direct importers; 72 test files.
- It calls `terminalSession`, `claudeTmux`, `nativeCompose` and `terminalPortal`: 10 `getState` calls at :368, 426, 458, 488, 506, 511, 648, 854, 869 and 1760.
- It imports `@/lib/backend`, `agent-handoff`, `tab-teardown-notice` and `browser-preview`.
- The default pane id is `"default"`, and tab ids are time-and-counter strings (§7.1). These collide across nodes, which is why the plan uses per-node instances.
- Companions:
  - `pane-layout-persistence.ts`: 910 LOC, 4 singletons; started in `App.tsx:367`.
  - `pane-layout-authoritative.ts`: 669 LOC, 3 singletons, 12 sites.
  - `pane-selection-storage.ts`: 495 LOC.

## Work

- [ ] Convert the store. Its calls to the four other stores go through `scope.store(def)`.
- [ ] Turn persistence and authoritative adoption into scoped services, with pending activations per scope.
- [ ] Make pane selection storage keys per node ([3015](3015-persistence-keys-per-node.md)).
- [ ] Bring the shim baseline to zero for every store the workspace subtree touches. List those stores in Notes, derived from the import graph of the `Workspace` component.

## Tests

- [ ] Two scopes with `"default"` panes and identical tab ids stay independent; layout persistence round-trips per node; authoritative adoption after reload.

## Done when

- [ ] The shim baseline is zero for the workspace subtree, and `mise run test` and `test:agent:browser` pass with only the command scope.
