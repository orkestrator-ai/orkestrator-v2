---
id: 0005
title: "Correct the federation and compatibility docs"
phase: 0
plan: "§12 Phase 0.5"
status: done
depends_on: []
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] Rewrite the renderer-runtime part of `federation.md` to describe realms, summaries and relayed events as they are. Keep `useBoundMachineView`, and make clear the backend `BackendRuntime` is unrelated.
- [x] `version-compatibility.md`:
  - say the renderer has no handshake, while backends exchange the hello;
  - update the floor sentence at :31 to today's computed floor, or reword it so it does not go stale.
- [x] Add a "Planned: unified federation" pointer in `federation.md` to the report and to this plan folder.

## Done when

- [x] `mise run format:check` passes, and a reviewer can find no mention of a removed symbol.

## Notes

- `federation.md` now has "Renderer: summaries, relayed events and realms" (portal channel, summaries, relayed events, explicit-owner actions and outcomes) and "Workspace realms: one realm per other node" in place of the old renderer-runtime and machine-panel sections. An `<a id="machine-panels-one-realm-per-machine">` anchor keeps the one inbound link (`docs/todo/coordinator-and-multi-review/6580-…`, retired 2026-11-11) working.
- The removed-symbol sweep went past the listed lines. Also corrected, each checked against the code: the status paragraph (realms exist again; saved machines are imported once by `importSavedMachinesOnce`), the Ownership and Components tables (`backend-panel-views.ts`, "registry, runtimes"), the hello capability list (now the ten node-mode capabilities and `nodeMode`; only backend code acts on them), the machine-profile bullet (no renderer runtime; `duplicateMachineColors` exists but no page calls it), the hosted-browser machine list in `localStorage` (gone), ConnectionManager "Bind and observe" (no `observe`/`unobserve`, no `panel:<uuid>` scope; realms use `realm:<viewId>` and `retargetScopeToWorkspace`), Events (`orkestrator:backend-event` is gone; realms' portal channel uses `orkestrator:portal-event`), the Freshness owner, the `federation` flag row, and Known limitations (realms have native previews and artifact hosts; iOS uses frame realms; no phone new-tab path; summaries persist on the command node, not the client).
- Found while checking, not fixed here (outside this item): the `federation` device flag is saved and shown ("Show all machines together") but nothing reads it; `apps/web/src/lib/federation/operation-recovery.ts` has no importers (outcomes are recorded by the command node now); `duplicateMachineColors` has no caller.
- The Acceptance-ID map still names `federation-runtime.test.ts` and `scripts/benchmark-federation.ts`; they are left as they were because the paragraph above the table already marks that map as historical.
- Floor: on 2026-11-07 no Stable release is 60 days old (the first, v2.21.0, is from 2026-10-16), so the floor is v2.21.0. The sentence now says "Until 2026-12-15 the floor is v2.21.0" plus how to compute it, so it does not go stale.
- `mise run format:check` passes (7518 files). An earlier run failed only on other agents' untracked, in-progress files under `apps/web/src/lib/node-scope/`, which are not part of this change.
- Effect: not used; documentation only.

## Work log

- 2026-11-07 (claude-worker): rewrote the renderer and realm sections of `docs/architecture/federation.md`, removed every mention of removed renderer symbols, added the "Planned: unified federation" section, and corrected the handshake paragraph and floor sentence in `docs/architecture/version-compatibility.md`. Validation: `mise run format:check` (pass).
