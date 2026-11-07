---
id: 0005
title: "Correct the federation and compatibility docs"
phase: 0
plan: "§12 Phase 0.5"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 0005 · Correct the federation and compatibility docs

- **Report:** [§12 Phase 0](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** none
- **Parallel with:** everything
- **Size:** S (documentation only; `mise run format:check` is the whole validation)
- **Track:** F (fixes now)

## Goal

The living docs describe the code as it is today, so later items start from correct references.

## Current state (verified 2026-11-07)

- `docs/architecture/federation.md` describes a renderer runtime that no longer exists:
  - `BackendClientRegistry` at :337
  - `BackendRuntime` at :341 and its section at :348
  - `useBoundMachineView` at :343
  - `BackendPanelViews` and `?panel=workspace` at :402-412
  - `machineViewStore.panels` at :404
- **Correction to the report:**
  - `useBoundMachineView` still exists (`apps/web/src/components/federation/useMachineViews.ts:162`).
  - A `BackendRuntime` class still exists, but it is the unrelated backend class at `apps/backend/src/core/backend-runtime.ts:67`.
  - `BackendClientRegistry`, `BackendPanelViews` and `machineViewStore.panels` are gone.
- `docs/architecture/version-compatibility.md:255` says "There is no version or capability handshake". That is true only for the renderer: the federation hello exists (`federation.md:95`). Line 31 ("Today (2026-10-24)") is stale.
- The register has 56 active rows, not 54.

## Work

- [ ] Rewrite the renderer-runtime part of `federation.md` to describe realms, summaries and relayed events as they are. Keep `useBoundMachineView`, and make clear the backend `BackendRuntime` is unrelated.
- [ ] `version-compatibility.md`:
  - say the renderer has no handshake, while backends exchange the hello;
  - update the floor sentence at :31 to today's computed floor, or reword it so it does not go stale.
- [ ] Add a "Planned: unified federation" pointer in `federation.md` to the report and to this plan folder.

## Done when

- [ ] `mise run format:check` passes, and a reviewer can find no mention of a removed symbol.
