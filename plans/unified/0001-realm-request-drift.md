---
id: 0001
title: "One shared definition for the realm open request"
phase: 0
plan: "§1 and §12 Phase 0.1"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
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

- [ ] Add `packages/protocol/src/realm-request.ts` (browser-safe). It holds:
  - `RealmBoardTab` and `RealmDialog` as `as const` lists;
  - the work-target shape (move the parts of `LocalWorkTarget` it needs from `apps/web/src/lib/coordinator-work-items`);
  - one `realmRequestToSearch(request): URLSearchParams` and one `parseRealmRequestSearch(search)`.
- [ ] Add the subpath to the `exports` map in `packages/protocol/package.json`. Every subpath is listed by hand there.
- [ ] Make `realmSearch` in main call the shared encoder, after validating the IPC input with the shared guards.
- [ ] Make `realmSearchParams` and `realmInitialRequest` on the web side use the shared encoder and parser. Keep the web types as re-exports so callers do not change.
- [ ] Decide, and record in Notes, whether `restart()` should keep marking the request delivered once main accepts every field. Recommended: keep it. The fix is that nothing is dropped, not that the request is sent twice.

## Tests

- [ ] One round-trip test in `packages/protocol`: every `RealmBoardTab`, every `RealmDialog`, `bugReport`, and each work-target type survive encode then parse.
- [ ] Extend `apps/desktop/tests/federation-ipc.test.ts` with `home`, each work-target type, a work target whose project does not match (refused), `bugReport`, and `environment-rebuild`.
- [ ] A drift test: the lists main accepts are the protocol lists, by identity, not a copy.

## Done when

- [ ] A cold desktop realm opened with each of the four fields does the right thing on first open. This needs one live check on a `dev:test` profile with a second profile attached; otherwise list it under "needs live evidence".

## Notes

- This code is deleted in [6003](6003-delete-desktop-realm-code.md). Keep the fix small; the shared module is worth it anyway because realms stay the fallback until Phase 6.
