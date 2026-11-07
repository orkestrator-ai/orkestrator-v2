---
id: 3004
title: "Convert projectStore and environmentStore"
phase: 3
plan: "§12 Phase 3.2"
status: not-started
depends_on: [3001, 3002, 3016]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3004 · Convert projectStore and environmentStore

- **Report:** [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [3001](3001-scoped-store-shim-and-ratchet.md), [3002](3002-lib-backend-client-parameter.md), [3016](3016-rich-content-and-caches.md) (`environmentStore` imports `rich-content-reset`)
- **Blocks:** [3006](3006-ui-store-split.md), [3009](3009-agent-and-transcript-stores.md), [3011](3011-workflow-stores-a.md), [3012](3012-workflow-stores-b.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

The core lists every node workspace needs are per node.

## Current state (verified 2026-11-07)

- `environmentStore`: 248 LOC, 57 imperative sites (46 in `.ts`), 45 direct importers, about 72 references, 96 test files.
  - Its only non-store dependency is `lib/chat/rich-content-reset` (identity clear), which [3016](3016-rich-content-and-caches.md) makes per node.
- `projectStore`: 149 LOC, 16/12, 13 direct importers, about 31 references, 38 test files. It has no store or service dependencies.
- Heaviest modules:
  - `hooks/useEnvironments.ts` has 21 sites;
  - `hooks/useProjects.ts` holds per-project maps and write tails (Appendix B);
  - `lib/store-resource-sync.ts` has 35 sites across stores; move the ones for these two stores here.

## Work

- [ ] Convert both stores and `useEnvironments`/`useProjects` (whose module maps become per scope).
- [ ] Move the `store-resource-sync.ts` handlers for projects and environments to a per-scope service ([3014](3014-scoped-services-and-startup.md) provides the framework; if it has not landed, register the handlers through the command scope and leave a box there).
- [ ] Convert imperative sites with a known scope. List the remaining shim sites per file in Notes.

## Tests

- [ ] Two scopes with the same environment id (allowed: ids are node-local) do not collide.
- [ ] The parity tests (`sidebar-parity.test.tsx`, `remote-row-parity.test.tsx`, `environment-row-model.parity.test.ts`) still pass.

## Done when

- [ ] Both stores are converted, and the shim count for each is at or below the target recorded in Notes.
