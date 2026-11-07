---
id: 3002
title: "lib/backend functions take a NodeClient"
phase: 3
plan: "§7.4 lib/backend"
status: not-started
depends_on: [2010]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3002 · lib/backend functions take a NodeClient

- **Report:** [§7.4](../../docs/reports/unified-federation.md#74-services-and-module-state) (the `lib/backend/*` bullet)
- **Depends on:** [2010](2010-command-scope-wiring.md)
- **Blocks:** the store items that call these functions ([3003](3003-stores-batch-a-leaf-light.md) onward)
- **Parallel with:** [3001](3001-scoped-store-shim-and-ratchet.md), Phase 7 (they meet here)
- **Size:** M (mechanical, large)
- **Track:** S (scopes)

## Goal

A scoped store can call every backend helper on its own node, by passing its client explicitly.

## Current state (verified 2026-11-07)

- `apps/web/src/lib/backend/` has 37 source files (8,226 LOC; the report says ~9.1k) and 10 tests, with 778 `export` declarations (the report says ~681).
- The barrel `lib/backend.ts` has 31 lines.
- There are 250 non-test importers: 213 via `@/lib/backend`, 44 via `@/lib/backend/*`.

## Work

- [ ] Choose the signature by file and record the choice in Notes. Recommended:
  - a factory per file, `createEnvironmentsApi(client)`, returning the same function names;
  - plus the existing named exports bound to the command scope as the shim.
  - This keeps every caller compiling, and lets a store do `const api = createEnvironmentsApi(scope.client)`.
- [ ] Convert all 37 files mechanically, behaviour-neutral. Do it file by file in a few PRs, grouped by domain so Phase 7 can later replace the bodies with domain clients.
- [ ] Source guard `lib-backend-command-default`: counts uses of the command-bound named exports from inside converted stores' modules and services. The baseline only shrinks, as in [3001](3001-scoped-store-shim-and-ratchet.md).

## Tests

- [ ] Each converted file's existing tests pass. Add one test per factory proving that a passed client is used rather than the command scope.

## Done when

- [ ] Every `lib/backend` file exposes a client-taking factory.
