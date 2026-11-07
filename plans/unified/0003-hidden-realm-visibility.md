---
id: 0003
title: "Tell hidden realm frames that they are hidden"
phase: 0
plan: "§3 P4 and §12 Phase 0.3"
status: done
depends_on: []
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] Add `{ type: "visibility", hidden: boolean }` to `ShellToRealmMessage` and its parser.
- [x] Pass `shown` into `useRealmRequests` (`RemoteWorkspaceRegion.tsx:163-334`). Send `visibility` on every change and again on `ready` (:261-269).
- [x] Add `setHostHidden(hidden: boolean)` to `ReadCoordinator`. Make `computePaused` treat `isHidden() || hostHidden` as hidden, with the same deferral and resume behaviour as a hidden window.
- [x] Handle the message in `WorkspaceRealmHost` by calling `getReadCoordinator().setHostHidden(...)`.
- [x] Measure whether a hidden desktop `WebContentsView` already reports `visibilityState: hidden` (§15). If it does, record that the desktop message is redundant but harmless.

## Tests

- [x] Read coordinator: a host-hidden coordinator defers like a hidden document, and a resume after host-visible re-reads authoritative snapshots.
- [x] Region test: hiding and showing a realm sends `visibility`, and `ready` re-sends the current value.
- [x] Parser test: an unknown type is still ignored, and malformed `visibility` messages are refused.

## Done when

- [x] The measured request rate from a hidden browser realm (see [0004](0004-measurement-report.md)) drops to the hidden-window rate.

## Notes

- Deleted with the realm protocol in [6002](6002-delete-web-realm-code.md). The `setHostHidden` override on the read coordinator survives: in-tree, a warm but hidden node scope uses the same override ([4002](4002-hydration-tiers-and-budgets.md)).
- `setHostHidden` is folded into the coordinator's `isHidden()` (`hostHidden || doc.visibilityState === "hidden"`), so `computePaused`, the visibility-change resume and diagnostics all see one hidden state: a document-visible event does not resume a frame the window still hides, and host-visible does not resume a hidden document. Diagnostics gain `hostHidden`; `hidden` is the combined value.
- Host visibility follows the region's `shown` (this realm is the active one and the region has a rect). It does not follow the desktop overlay step-aside (`covered`), when a native view is hidden for a moment so the window's dialog can draw over its still; that is brief and the user is still looking at the realm.
- Scope: only the read coordinator honours the message. Other #1964-era hidden checks that read `document.visibilityState` directly (`store-resource-sync.ts`, `pullRequestsStore.ts`, `useEnvironments.ts`, `terminal-websocket-client.ts`, `web-gateway.ts` stream retry and others) still see a hidden realm frame as visible. Worth a follow-up if the 0004 measurement shows a hidden realm still reads above the hidden-window rate.
- Desktop main needed no change; `boundedMessage` passes `visibility` through.
- Effect: not used. The change is a boolean override in an existing imperative scheduler and one more message type; nothing here is an effect pipeline.
- Measured 2026-11-07 ([measurements report](../../docs/reports/unified-federation-measurements.md#hidden-realms)):
  - Desktop: a realm `WebContentsView` hidden with `setVisible(false)` reports `visibilityState: "visible"` and its 100 ms interval is not throttled (100 ticks in 10 s), in hidden-windows mode, in a normal shown window and with the window minimized (Electron 45, development build, launched without the spec suite's anti-throttling switches). So the desktop `visibility` message is **not** redundant: it is the only hidden signal a desktop realm gets. (The minimized-window case also reporting visible is unexpected; worth repeating on a workstation.)
  - Browser (Chromium, two `dev:test` profiles plus extra leaves, 120 s per run, three realms open): before 0003 (the four web files reverted to `349ab688d~1` in the live worktree) a region-hidden realm read at the shown rate, 13.0 requests/min (`get_system_usage` every 5 s, `check_docker`); after 0003 it read **0/min**, the same as a realm whose document was also forced hidden (the hidden-window rate, 0/min). The shown realm stayed at 13.0/min.

## Work log

- 2026-11-07 (claude-worker): added the `visibility` shell→realm message and parser; `useRealmRequests` sends it on every `shown` change and on `ready` for desktop and frame realms; `ReadCoordinator.setHostHidden` defers and resumes like a hidden document; `WorkspaceRealmHost` applies it. Tests: read coordinator (2 new), region (desktop multi-realm and browser frame, 2 new), realm host (1 new), parser (1 new); web federation folders 412 pass, read coordinator and related suites 172 pass; web typecheck clean.
- 2026-11-07 (claude-worker, live evidence): hidden WebContentsView measured (reports visible, timers unthrottled: message needed); hidden browser realm request rate measured before (13.0/min) and after (0/min = hidden-window rate) 0003. All boxes ticked; status done.
