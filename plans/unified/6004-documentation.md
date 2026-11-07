---
id: 6004
title: "Living documentation for unified federation"
phase: 6
plan: "§12 Phase 6.4"
status: not-started
depends_on: [6002, 6003]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 6004 · Living documentation for unified federation

- **Report:** [§12 Phase 6](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [6002](6002-delete-web-realm-code.md), [6003](6003-delete-desktop-realm-code.md)
- **Size:** S
- **Track:** S (scopes), documentation only

## Work

- [ ] `docs/architecture/command-nodes.md`: rewrite "Opening an environment on another node" for node scopes.
- [ ] `docs/architecture/federation.md`: mark the realm sections retired. Describe scopes, tiers, budgets, snapshots and the summary overlay.
- [ ] `docs/architecture/renderer-security.md`: scopes instead of realm views; the authority analysis from report §10.1; credentials stay in main on desktop and in closures in the browser.
- [ ] `docs/development/node-scopes.md` (from [3001](3001-scoped-store-shim-and-ratchet.md)): final form, with the shim removed.
- [ ] Update the federation row in the root `AGENTS.md` table and `docs/README.md`.
- [ ] Archive the report per `docs/README.md`'s rule for completed plans, once Phase 7 no longer needs it as the reference.

## Done when

- [ ] `mise run format:check` passes and no living doc mentions realms as current.
