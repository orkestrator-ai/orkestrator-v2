---
id: 0003
title: "Tell hidden realm frames that they are hidden"
phase: 0
plan: "§3 P4 and §12 Phase 0.3"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 0003 · Tell hidden realm frames that they are hidden

- **Report:** [§3 P4](../../docs/reports/unified-federation.md#3-what-is-wrong-with-it), [§12 Phase 0](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** none
- **Parallel with:** everything
- **Size:** S
- **Track:** F (fixes now)

## Goal

The hidden-window read deferrals from #1964 apply to hidden realms, so a hidden realm stops reading at full rate.

## Current state (verified 2026-11-07)

- Hiding a realm:
  - Browser and iOS: `FrameRealm` wraps a hidden realm's iframe in a `hidden` (display:none) div (`RemoteWorkspaceRegion.tsx:610`).
  - Desktop: `NativeRealm` calls `api.setVisible(viewId, visible)` (:472-477), which reaches `view.setVisible` in `apps/desktop/electron/workspace-views.ts:290-294, 395-410`.
  - Nothing tells the realm's own document.
- `apps/web/src/lib/read-coordinator.ts` decides visibility only from `doc.visibilityState === "hidden"` (:456-458), with listeners at :859-869. A display:none iframe keeps the top page's state, so it reads as visible. `ReadCoordinator` (:271-298) has `setDataSaving` and `setDisconnected` but no external hidden override. The shared instance is built in `getReadCoordinator` (:1148-1157).
- Shell→realm messages are `ShellToRealmMessage` (`workspace-realm.ts:193-211`), parsed by `parseShellMessage` (:369-419) and handled in `WorkspaceRealmHost.tsx:99-126`. An older realm ignores unknown types, because the parser returns null.
- Desktop main passes messages through unchanged (`boundedMessage` ≤ 4096 B, `federation-ipc.ts:188-192`), so main needs no change.

## Work

- [ ] Add `{ type: "visibility", hidden: boolean }` to `ShellToRealmMessage` and its parser.
- [ ] Pass `shown` into `useRealmRequests` (`RemoteWorkspaceRegion.tsx:163-334`). Send `visibility` on every change and again on `ready` (:261-269).
- [ ] Add `setHostHidden(hidden: boolean)` to `ReadCoordinator`. Make `computePaused` treat `isHidden() || hostHidden` as hidden, with the same deferral and resume behaviour as a hidden window.
- [ ] Handle the message in `WorkspaceRealmHost` by calling `getReadCoordinator().setHostHidden(...)`.
- [ ] Measure whether a hidden desktop `WebContentsView` already reports `visibilityState: hidden` (§15). If it does, record that the desktop message is redundant but harmless.

## Tests

- [ ] Read coordinator: a host-hidden coordinator defers like a hidden document, and a resume after host-visible re-reads authoritative snapshots.
- [ ] Region test: hiding and showing a realm sends `visibility`, and `ready` re-sends the current value.
- [ ] Parser test: an unknown type is still ignored, and malformed `visibility` messages are refused.

## Done when

- [ ] The measured request rate from a hidden browser realm (see [0004](0004-measurement-report.md)) drops to the hidden-window rate.

## Notes

- Deleted with the realm protocol in [6002](6002-delete-web-realm-code.md). The `setHostHidden` override on the read coordinator survives: in-tree, a warm but hidden node scope uses the same override ([4002](4002-hydration-tiers-and-budgets.md)).
