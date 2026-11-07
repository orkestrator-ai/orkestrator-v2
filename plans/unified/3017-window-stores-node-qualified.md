---
id: 3017
title: "Window stores with node-qualified references"
phase: 3
plan: "§7.1 class (b) and Appendix A"
status: not-started
depends_on: [2001]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3017 · Window stores with node-qualified references

- **Report:** [§7.1](../../docs/reports/unified-federation.md#71-inventory), [Appendix A](../../docs/reports/unified-federation.md#appendix-a-store-classification)
- **Depends on:** [2001](2001-node-scope-core.md)
- **Blocks:** [3006](3006-ui-store-split.md), [5003](5003-settings-bug-report-shortcuts-dialogs.md)
- **Size:** S–M
- **Track:** S (scopes)

## Goal

Window-level stores that point at a project, environment, conversation or message say which node it is on.

## Stores (verified 2026-11-07)

- `appDialogStore` (35 LOC, 4 sites)
- `mergePrRequestStore` (34, 5)
- `activeCoordinatorConversationStore` (86, 2; imports a type from `uiStore`)
- `conversationScrollTargetStore` (167, 2)
- `messagePartExpansionStore` (123, 0)
- `flowGraphViewStore` (104, 4)
- `useHostPathPickerStore` (`lib/host-path-picker.ts`, a `create()` store outside `stores/`; the request must carry a node)
- `bugReportStore` (26, 7/3): stays window-level, but the report runs against a chosen scope ([5003](5003-settings-bug-report-shortcuts-dialogs.md)).

## Work

- [ ] Add `nodeId` to every reference these stores hold. Producers pass the scope's node, and readers resolve the scope before acting.
- [ ] The host path picker runs its request on the requesting node's client.

## Tests

- [ ] A dialog opened for node B acts on B; a scroll target for node A is ignored while B is shown.

## Done when

- [ ] Every reference in these stores is node-qualified.
