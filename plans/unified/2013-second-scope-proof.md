---
id: 2013
title: "Phase 2 exit: a second node scope works on both host families"
phase: 2
plan: "§12 Phase 2 exit"
status: not-started
depends_on: [2004, 2005, 2008, 2009, 2010]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 2013 · Phase 2 exit: a second node scope works on both host families

- **Report:** [§12 Phase 2](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [2004](2004-browser-node-clients-registry.md), [2005](2005-relay-status-and-session.md), [2008](2008-desktop-request-auth.md), [2009](2009-desktop-previews-and-gateway-snapshot.md), [2010](2010-command-scope-wiring.md)
- **Blocks:** [4001](4001-in-tree-workspace-seam.md)
- **Size:** S
- **Track:** S (scopes)

## Goal

Demonstrate, against real backends, that one renderer can hold the command scope and a leaf scope at once.

## Work

- [ ] A test-only page or harness, mounted only in `dev:test` profiles, that creates a leaf `NodeScope` next to the command scope. It invokes a read on each, listens to `resource-changed` on each, and opens a terminal on the leaf.
- [ ] Run it on desktop (Electron spec) and browser (Playwright) against two `dev:test` profiles, one attached to the other, over direct and relay routes.
- [ ] Record evidence in Notes:
  - the commands run;
  - pass counts;
  - observed `nextHopProtocol`;
  - the number of long-lived requests per origin.

## Tests

- [ ] The report's Phase 2 test list, each pointing to the item that added it:
  - node-tagged event demux: [2007](2007-desktop-node-ipc-and-events.md);
  - scope lifecycle (lazy open, renew, idle release, window close): [2006](2006-desktop-node-scopes.md) and [2004](2004-browser-node-clients-registry.md);
  - longest-prefix auth: [2008](2008-desktop-request-auth.md);
  - tab-to-node preview routing: [2009](2009-desktop-previews-and-gateway-snapshot.md);
  - admin refusal by `nodeId`: [2007](2007-desktop-node-ipc-and-events.md);
  - grant reopen without reload: [2004](2004-browser-node-clients-registry.md).

## Done when

- [ ] Both host families pass the harness live, and the app is otherwise unchanged.
