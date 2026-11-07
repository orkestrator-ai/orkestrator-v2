---
id: 1008
title: "Contract CI job against the support window"
phase: 1
plan: "§11.3 steps 3 and 5 and §12 Phase 1.4"
status: not-started
depends_on: [1007, 1009]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 1008 · Contract CI job against the support window

- **Report:** [§11.3 Manifests and CI](../../docs/reports/unified-federation.md#113-manifests-and-ci)
- **Depends on:** [1007](1007-release-snapshots-and-backfill.md), [1009](1009-domain-clients-and-adapters.md)
- **Blocks:** [1010](1010-pilot-node-mail-and-ticket-sync.md) exit, and all of Phase 7
- **Size:** M
- **Track:** C (contract)

## Goal

On every PR, CI proves that the current code still serves every client in the support window, and still has a client adapter for every backend in it.

## Current state (verified 2026-11-07)

- The floor rule (`version-compatibility.md:14-46`): the newest Stable release published at least 60 days ago, otherwise v2.21.0.
- The register (`version-compatibility.md:120-216`) has 56 rows with columns `Path | Where | Counter | Serves | Retire when | Owner`. Nothing tests it today.
- Usage counter ids are in `COMPATIBILITY_PATH_IDS` (`apps/backend/src/core/compatibility-path-usage.ts:21`).

## Work

Stage 1, enabled with this item:

- [ ] Compute the floor from `contracts/releases/index.json` and today's date (injected, for tests).
- [ ] For every (domain, version) that appears in any in-window snapshot, assert a client adapter exists. Adapters are listed in a committed `contracts/adapters.json`, written by the adapter registry in [1009](1009-domain-clients-and-adapters.md).
- [ ] Assert that no command in an in-window snapshot disappeared without a domain bump and a register row naming it.
- [ ] Register consistency: every register row with a counter names an id in `COMPATIBILITY_PATH_IDS`, and every domain bump has a row.

Stage 2, enabled when the first domain other than the pilot converts:

- [ ] For every defined command in an in-window snapshot, generate argument fixtures from its old schema and assert that the current backend's parser accepts them. Run this through the real `register(def)` parser, not a copy.
- [ ] Flag a new required field without a version bump.

## Tests

- [ ] Each check has a failing fixture: a missing adapter, a removed command, a new required field, and a register row without a counter id.

## Done when

- [ ] Stage 1 runs on every PR in the same workflow as `contract:check`. Stage 2 is listed as a box on [7001](7001-domain-native-sessions.md).
