---
id: 1012
title: "Scheduled mixed-version qualification"
phase: 1
plan: "§11.3 step 4"
status: not-started
depends_on: [1010]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 1012 · Scheduled mixed-version qualification

- **Report:** [§11.3 step 4](../../docs/reports/unified-federation.md#113-manifests-and-ci)
- **Depends on:** [1010](1010-pilot-node-mail-and-ticket-sync.md)
- **Parallel with:** Phase 7 conversions (each adds its domain's scenarios here)
- **Size:** M
- **Track:** C (contract)

## Goal

On a schedule, not per PR, run the current client and backend against the floor release's backend, both directions, for every converted domain.

## Current state (verified 2026-11-07)

- `scripts/qualify-design-mixed-versions.ts` (500 lines) installs a published `orkestrator` npm release (default `--old-version 2.22.3`, `--ignore-scripts`). It runs that backend and the current one over one data directory.
- `scripts/qualify-backend-upgrade-rollback.ts` (1438 lines) runs releases from detached worktrees with their pinned Bun.

## Work

- [ ] Generalise the design script into `scripts/qualify-contract-mixed-versions.ts` with per-domain scenario modules. The first module covers the pilot: node mail delivery with and without `steer`, outbox collect/ack, ticket sync, file transfer.
- [ ] Default `--old-version` is the computed floor from `contracts/releases/index.json`.
- [ ] Two topologies: the current command node with a floor leaf, and the floor command node with a current leaf.
- [ ] A scheduled GitHub workflow (weekly). It needs explicit user approval before it is enabled, because it is a repository workflow change.

## Done when

- [ ] The script passes locally for the pilot, and the workflow file is ready for the user to enable.
