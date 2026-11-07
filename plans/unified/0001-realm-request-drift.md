---
id: 0001
title: "One shared definition for the realm open request"
phase: 0
plan: "§1 and §12 Phase 0.1"
status: done
depends_on: []
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 0001 · One shared definition for the realm open request

- **Report:** [§1 Summary, "Two things to fix now"](../../docs/reports/unified-federation.md#1-summary), [§12 Phase 0](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** none
- **Parallel with:** everything. This is a bug fix and must not wait for the rebuild.
- **Size:** S
- **Track:** F (fixes now)

## Goal

On a cold desktop realm, every field that the window asks for reaches the realm, and the two sides cannot drift apart again.

## Current state (verified 2026-11-07 at `521f734a9`)

- Main builds the realm URL in `realmSearch`, `apps/desktop/electron/federation-ipc.ts:141-169`. It is called from the `orkestrator:workspace-views:open` handler at :326.
  - It accepts `boardTab` only as coordinator, kanban, github, linear or features (:150-158).
  - It accepts `dialog` only as repository-settings, delete-project or environment-settings (:161-167).
- The web side writes the URL in `realmSearchParams`, `apps/web/src/lib/federation/workspace-realm.ts:316-341`, and reads it in `realmInitialRequest` (:344-367) through `parseShellMessage` (:369-419).
- Main drops exactly four things the web side writes:
  - `boardTab: "home"`
  - `workType`/`workId`
  - `bugReport=1`
  - `dialog: "environment-rebuild"`
- Main receives the request object over IPC (`Omit<RealmSelectRequest, "type">`, `apps/web/src/vite-env.d.ts:207-210`, preload `preload-api.ts:435-437`). It does not receive URL parameters. So main must validate a nested `workTarget: {type, projectId, environmentId, tabId|pipelineId|workflowId|runId}` and turn it into `workType`/`workId`. The web side's `workTarget()` (:156-174) requires the target's project and environment to match the request's.
- `restart()` in `apps/web/src/components/federation/RemoteWorkspaceRegion.tsx:232-255` sets `delivered.current = request.seq` (:242-243). So `flush()` on `ready` never sends a request again, and the dropped fields are lost for good.
- `apps/desktop/tests/federation-ipc.test.ts` (284 lines) covers board tabs (:57-69) and IDs and dialogs (:110-146). It never tests `home`, `workTarget`, `bugReport` or `environment-rebuild`.
- `packages/protocol` has no shared type for this. The precedent for a module shared by desktop main and web is `packages/protocol/src/realm-boot-timing.ts`.

## Work

- [x] Add `packages/protocol/src/realm-request.ts` (browser-safe). It holds:
  - `RealmBoardTab` and `RealmDialog` as `as const` lists;
  - the work-target shape (move the parts of `LocalWorkTarget` it needs from `apps/web/src/lib/coordinator-work-items`);
  - one `realmRequestToSearch(request): URLSearchParams` and one `parseRealmRequestSearch(search)`.
- [x] Add the subpath to the `exports` map in `packages/protocol/package.json`. Every subpath is listed by hand there.
- [x] Make `realmSearch` in main call the shared encoder, after validating the IPC input with the shared guards.
- [x] Make `realmSearchParams` and `realmInitialRequest` on the web side use the shared encoder and parser. Keep the web types as re-exports so callers do not change.
- [x] Decide, and record in Notes, whether `restart()` should keep marking the request delivered once main accepts every field. Recommended: keep it. The fix is that nothing is dropped, not that the request is sent twice.

## Tests

- [x] One round-trip test in `packages/protocol`: every `RealmBoardTab`, every `RealmDialog`, `bugReport`, and each work-target type survive encode then parse.
- [x] Extend `apps/desktop/tests/federation-ipc.test.ts` with `home`, each work-target type, a work target whose project does not match (refused), `bugReport`, and `environment-rebuild`.
- [x] A drift test: the lists main accepts are the protocol lists, by identity, not a copy.

## Done when

- [x] A cold desktop realm opened with each of the four fields does the right thing on first open. This needs one live check on a `dev:test` profile with a second profile attached; otherwise list it under "needs live evidence".

## Notes

- This code is deleted in [6003](6003-delete-desktop-realm-code.md). Keep the fix small; the shared module is worth it anyway because realms stay the fallback until Phase 6.
- `restart()` decision: keep marking the request delivered when a new document opens. Main now accepts every field the web side writes, so the realm's first URL carries the whole request and sending it again on `ready` would only apply it twice (a dialog or bug report sheet opened twice). A one-line comment in `restart()` records why.
- Shape: `packages/protocol/src/realm-request.ts` holds `REALM_BOARD_TABS`, `REALM_DIALOGS`, `REALM_WORK_TYPES` (`as const`), `RealmWorkTarget` (the four local variants, moved from `coordinator-work-items`; `LocalWorkTarget` is now an alias of it), `RealmOpenRequest`, the guards (`realmId`, `isRealmBoardTab`, `isRealmDialog`, `isRealmWorkType`, `isEnvironmentDialog`, `parseRealmWorkTarget`), one normaliser `parseRealmRequest`, the encoder `realmRequestToSearch` (normalises before writing, so only accepted fields reach a URL) and the parser `parseRealmRequestSearch`. The web `parseShellMessage` `select` branch and `parseRealmMessage` `open` branch use the same guards, so the select message, the browser URL and the desktop URL share one validation.
- Main still throws on a malformed project, environment or create-environment ID (unchanged behaviour); an unknown tab or dialog, or a work target off the request's own project or environment, is dropped rather than failing the open, as the realm itself drops it. `REALM_SEARCH_ACCEPTS` in `federation-ipc.ts` exposes the protocol lists for the identity drift test.
- Effect: not used. This is a pure synchronous encode/parse pair shared with a browser bundle; plain guards are smaller and match the neighbouring `realm-boot-timing` module.
- Live check (2026-11-07): a real Electron 45 command node (development build, agent-test profile, Playwright-launched; `output/agent-testing/uf-live/scripts/uf-live-measure-electron.spec.ts`) with a leaf backend from source. Each cold realm was opened through the preload API the window's `NativeRealm` uses (`workspaceViews.open({ nodeId, request })`) with the request shape the web side sends, rather than by clicking through the window UI, and closed before the next. The realm's URL as built by main carried the field each time (`boardTab=home`; `workType=graph-run` + `workId`; `bugReport=1`; `dialog=environment-rebuild`), and the realm acted on it on first open: Home tab selected; a "Graph run 1" tab opened; the Report a bug sheet open; Environment Settings open. Evidence: `output/agent-testing/uf-live/electron-measurements.json` (`0001`), summarised in [the measurements report](../../docs/reports/unified-federation-measurements.md). Deviation (2026-11-07): the Done-when names a `dev:test` profile with a second profile attached; the check ran on the Electron spec harness instead (its own agent-test profile plus an attached leaf backend), because a `dev:test` profile's Electron cannot be driven from Playwright. The path checked (window IPC, main's `realmSearch`, a cold `WebContentsView`) is the same. The work target used was `graph-run` (the one with a visible effect without seeded work); the other three types share the same encoder path covered by the protocol round-trip test.

## Work log

- 2026-11-07 (claude-worker): added the shared `realm-request` protocol module and export; desktop `realmSearch` and the web encoder, URL parser and message parsers now use it; `LocalWorkTarget` aliases the protocol work target. Tests: `packages/protocol/src/realm-request.test.ts` (4 pass), `apps/desktop/tests/federation-ipc.test.ts` (16 pass, 2 new plus `home` in the board-tab test), web realm suites (workspace-realm, RemoteWorkspaceRegion, WorkspaceRealmHost, coordinator-work-navigation, app-shortcuts: 99 pass). Protocol, desktop and web typecheck clean.
- 2026-11-07 (claude-worker, live evidence): cold desktop realm checked live with `home`, a `graph-run` work target, `bugReport` and `environment-rebuild`; none dropped, each applied on first open. Done-when ticked; status done.
