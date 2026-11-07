---
id: 5005
title: "Optional: multiplexed relay event stream"
phase: 5
plan: "§6.2 Connection budget and §12 Phase 5b"
status: not-started
depends_on: [0004, 4002]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 5005 · Optional: multiplexed relay event stream

- **Report:** [§6.2 Connection budget](../../docs/reports/unified-federation.md#62-browser-and-ios), [§13.4 C](../../docs/reports/unified-federation.md#134-browser-path-to-leaves)
- **Depends on:** [0004](0004-measurement-report.md), [4002](4002-hydration-tiers-and-budgets.md)
- **Condition:** do this only if [0004](0004-measurement-report.md) or [4006](4006-multi-node-qualification.md) shows HTTP/1.1 connection pressure on the relay path after direct-first routing, WebSocket terminals and suspension. Otherwise set `dropped` with the measured reason.
- **Size:** M
- **Track:** S (scopes), backend

## Goal

One long-lived request carries the main event streams of N relayed leaves.

## Work

- [ ] Backend route `/__orkestrator/nodes/events?nodes=a,b`, merging N leaf main streams.
  - Per-node cursor, echoing the client's cursor on `connected` (invariant 8).
  - Subscribe before computing replay (invariant 7).
  - Explicit byte and count bounds on every buffer (invariant 11).
  - Grant-authorised per node, refusing nodes the client holds no grant for.
  - Estimated at 250-400 LOC plus tests.
- [ ] Do not extend `NodeEventRelay`: it is built for prefix leases with no terminals.
- [ ] The browser node client uses the multiplexed stream when several relayed nodes are warm, and falls back to per-node streams on an older command node (404 or 405 means an older backend).
- [ ] Add a register row if the client branches on the command node's version.

## Done when

- [ ] Either it is implemented with tests and measured relief, or it is dropped with the measurements that justify that.
