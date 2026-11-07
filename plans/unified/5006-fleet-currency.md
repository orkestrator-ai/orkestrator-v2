---
id: 5006
title: "Keep the fleet current: version skew in the sidebar and an update policy"
phase: 5
plan: "§11.6"
status: not-started
depends_on: [1004, 1005]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 5006 · Keep the fleet current: version skew in the sidebar and an update policy

- **Report:** [§11.6 Operational mitigation](../../docs/reports/unified-federation.md#116-operational-mitigation-keep-the-fleet-current)
- **Depends on:** [1004](1004-hello-domains.md), [1005](1005-typed-incompatibility-errors.md)
- **Parallel with:** everything in Phases 2-4 (it needs only the contract track)
- **Size:** M
- **Track:** C (contract), UI

## Goal

For one user's fleet, most skew is "not updated yet". Make that visible and one click away.

## Current state (verified 2026-11-07)

- "Update app to latest" across machines exists: `components/settings/machines/BulkUpdateDialog.tsx` and `machineBulkUpdateStore` (51 LOC).

## Work

- [ ] Sidebar machine header: when a node's version differs from the command node's, show it, with the domains the node lacks (from the hello `domains` versus the command node's). Summary-tier nodes take this from command-node summaries; check whether `get_node_summaries` already carries the version and the hello domains, and add them if not.
- [ ] Typed incompatibility errors ([1005](1005-typed-incompatibility-errors.md)) link to the update action for that machine.
- [ ] Optional, and needing user approval for its default: an opt-in update policy per channel, "keep leaves on the command node's version". The command node runs it through the node link's existing host-maintenance path.

## Tests

- [ ] The header with equal, older and pre-contract nodes; the error link opens the update for the right machine.
- [ ] Screenshots of the header and the error state (the visual-change rule in `AGENTS.md`).

## Done when

- [ ] A skewed node is visible in the sidebar, and its typed errors lead to its update.
