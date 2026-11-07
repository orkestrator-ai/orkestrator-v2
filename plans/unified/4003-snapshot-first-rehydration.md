---
id: 4003
title: "Snapshot-first rehydration from IndexedDB"
phase: 4
plan: "§8.3 and §12 Phase 4.4"
status: not-started
depends_on: [4001]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 4003 · Snapshot-first rehydration from IndexedDB

- **Report:** [§8.3 Snapshot-first rehydration](../../docs/reports/unified-federation.md#83-snapshot-first-rehydration)
- **Depends on:** [4001](4001-in-tree-workspace-seam.md)
- **Parallel with:** [4002](4002-hydration-tiers-and-budgets.md), [4004](4004-runtime-shim-guard.md), [4005](4005-direct-navigation.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

Opening a node that was disposed, or opening one after an app restart, paints immediately from a bounded local snapshot, then replaces it with the authoritative read.

## Current state (verified 2026-11-07)

- **There is no IndexedDB code in the web app.** No `indexedDB`, `idb`, `idb-keyval`, `dexie`, `localforage` or `fake-indexeddb` appears anywhere. Persistence is localStorage and sessionStorage only.
- Tests run on happy-dom, which (from memory, unverified here) provides no IndexedDB, so tests need a fake.

## Work

- [ ] A small IndexedDB wrapper in `apps/web/src/lib/node-scope/snapshot-store.ts`, with byte bounds per node and in total, and least-recently-used eviction. Decide between hand-written code and a tiny dependency such as `idb-keyval`; record the decision with pros and cons. A dependency needs lockfile regeneration.
- [ ] A test fake: either a `fake-indexeddb` dev dependency registered for the tests that need it (not globally, per the `mock.module` rules), or an injectable backend.
- [ ] Each warm scope periodically writes a light snapshot: projects, environments, config, pane layout ids and last selection. The key is node-namespaced.
  - It never contains transcripts, terminal contents, file contents, prompts or credentials (invariant 12). Keep only what the sidebar summaries already expose.
- [ ] On open, the scope hydrates from the snapshot and marks itself `resyncing`. The UI shows a stale marker, and mutations wait for `live`.
- [ ] Clear a node's snapshot when the node is removed from the registry or on sign-out.

## Tests

- [ ] Snapshot bounds and eviction; content rules (a test that tries to write a forbidden field fails); stale marker then live; mutations wait for live.

## Done when

- [ ] A cold open of a previously seen node paints from the snapshot before the first authoritative read, on desktop and browser.
