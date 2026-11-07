---
id: 3011
title: "Convert pipeline, Kanban, feature plan, coordinator and graph stores"
phase: 3
plan: "§12 Phase 3.5"
status: not-started
depends_on: [3004]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3011 · Convert pipeline, Kanban, feature plan, coordinator and graph stores

- **Report:** [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [3004](3004-project-and-environment-stores.md)
- **Parallel with:** [3012](3012-workflow-stores-b.md), [3009](3009-agent-and-transcript-stores.md)
- **Size:** L
- **Track:** S (scopes)

## Stores (verified 2026-11-07)

- `buildPipelineStore` (222 LOC). It has 46 imperative sites, but **19 are in `components/build-pipeline/build-chat-tab-test-support.tsx`**, so 27 are production code.
  - Companion modules: `build-pipeline-persistence.ts` (652 LOC, 8 singletons, 10 sites), `build-pipeline-completion-notes.ts` (started in `App.tsx:369`), `feature-build-activation.ts`.
- `kanbanStore` (305 LOC, 8/7). It calls `buildPipelineStore` (:177), so convert it after or with the pipeline store.
- `featurePlanStore` (293 LOC, 7/3)
- Coordinator stores:
  - `coordinatorActivityStore` 149
  - `coordinatorLaunchOverrideStore` 157
  - `coordinatorPaneLayoutStore` 297
- Graph stores:
  - `graphDesignerStore` 738
  - `graphRunStore` 312
  - `graphDescribeStore` 127
- `lib/coordinator-work-navigation.ts` (170 LOC, 4 singletons), `lib/prompt-queue-*`.

## Work

- [ ] Convert in this order: pipeline, Kanban, feature plan, coordinator, graphs.
- [ ] Turn pipeline persistence, completion notes and feature-build activation into scoped services ([3014](3014-scoped-services-and-startup.md)).
- [ ] Move `build-chat-tab-test-support.tsx` to `renderInNodeScope`, which removes its 19 static calls.

## Tests

- [ ] A pipeline launched on the command scope and observed from a second scope (fake) keeps independent state.
- [ ] Graph designer and run view suites pass.

## Done when

- [ ] All stores in this item are converted, with shim counts at target.
