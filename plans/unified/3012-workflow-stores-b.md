---
id: 3012
title: "Convert design, web annotation, GitHub, PR, change, file and preview stores"
phase: 3
plan: "§12 Phase 3.5"
status: not-started
depends_on: [3004, 3016]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3012 · Convert design, web annotation, GitHub, PR, change, file and preview stores

- **Report:** [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [3004](3004-project-and-environment-stores.md), [3016](3016-rich-content-and-caches.md) (capability caches per scope)
- **Parallel with:** [3011](3011-workflow-stores-a.md), [3009](3009-agent-and-transcript-stores.md)
- **Size:** L
- **Track:** S (scopes)

## Stores (verified 2026-11-07)

- `designStore` (150 LOC, 5 sites), with `lib/design-client.ts` (372 LOC; capability `Map` at :109).
- `webAnnotationStore` (433 LOC, 20/20), `webAnnotationPreferencesStore` (57 LOC, persisted).
  - `lib/web-annotations/sync.ts` (737 LOC, 14 sites).
  - `lib/web-annotations/local-drafts.ts:13` uses the un-namespaced key `orkestrator.web-annotations.local-drafts.v1`.
- `githubIssuesStore` (568), `pullRequestsStore` (558, 10/8).
- `changeProjectionStore` (149, 8/8), with `lib/changes/subscriptions.ts` (291 LOC, 10 singletons) and `lib/backend/changes.ts:129` (capability `let`).
- `fileDirtyStore` (165, 6/1), with `file-draft-persistence.ts` (229 LOC, 4 singletons) and `file-subtree-loads.ts`.
- `previewServiceStore` (283, 14/10).

## Work

- [ ] Convert each store. Turn the sync engines and subscriptions into scoped services.
- [ ] Namespace the local-drafts key by node ([3015](3015-persistence-keys-per-node.md)), migrating the existing un-namespaced data to the command node.
- [ ] The preview service store uses the node client's preview URLs ([2004](2004-browser-node-clients-registry.md), [2009](2009-desktop-previews-and-gateway-snapshot.md)).

## Done when

- [ ] All stores in this item are converted, with shim counts at target, and the web annotation and design suites pass.
