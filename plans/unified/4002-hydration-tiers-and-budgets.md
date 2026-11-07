---
id: 4002
title: "Hydration tiers, suspension and byte budgets"
phase: 4
plan: "§8.1-8.2 and §12 Phase 4.4"
status: done
depends_on: [4001, 0004]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 4002 · Hydration tiers, suspension and byte budgets

- **Report:** [§8.1 Tiers](../../docs/reports/unified-federation.md#81-tiers), [§8.2 Budgets per host](../../docs/reports/unified-federation.md#82-budgets-per-host)
- **Decision:** 13.3 B (byte budgets with tiers)
- **Depends on:** [4001](4001-in-tree-workspace-seam.md), [0004](0004-measurement-report.md) (defaults)
- **Blocks:** [4006](4006-multi-node-qualification.md), [5005](5005-multiplexed-relay-stream.md)
- **Parallel with:** [4003](4003-snapshot-first-rehydration.md), [4004](4004-runtime-shim-guard.md), [4005](4005-direct-navigation.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

The memory budget, not a count, decides how many nodes stay warm. Eviction drops data (one environment's transcript), not whole apps. This replaces `MAX_OPEN_REALMS` and `DEFAULT_MAX_VIEWS` for in-tree nodes.

## Work

- [x] A lifecycle manager on `WindowScope` with tiers summary → warm → live → suspended, as in the §8.1 table. Each scope records `lastShown`.
- [x] Transitions:
  - **Open:** summary → warm → live.
  - **Switch away:** live → warm. Heavy data is released to the window budgets on demand.
  - **Warm, hidden past `NODE_SUSPEND_AFTER_MS`:** the scope suspends. Streams close, the cursor is kept, and services stop. A suspended scope is also told it is host-hidden (`setHostHidden`).
  - **Switch back:** the scope resumes from the cursor. A gap gives `gateway.reconcile-required` and stores re-read their snapshots (invariants 3, 4, 7 and 8).
- [x] Pressure order: drop heavy data of the least recently shown live nodes, then suspend warm nodes, then dispose suspended scopes back to summary. Never touch the shown node.
- [x] Per-host defaults from [0004](0004-measurement-report.md):
  - desktop 15 min;
  - browser 5 min;
  - iOS 2 min, and immediately on `visibilitychange` hidden.
  - Budgets: `measureUserAgentSpecificMemory` where available, a fixed conservative fallback on iOS.
- [x] Desktop main releases idle node scopes ([2006](2006-desktop-node-scopes.md)) when the renderer disposes a scope.
- [x] Optional: a memory-warning hook from the iOS app's WebView, mapped to the pressure path.

## Tests

- [x] The tier state machine under each transition; the pressure order; the shown node is never evicted.
- [x] Resume after a gap triggers resync rather than replaying stale events.
- [x] Timers are stopped on dispose.

## Done when

- [x] Six fake nodes cycle through switching with bounded memory in a test, and the budgets are configurable per host.

## Notes

- **API (2026-11-07).**
  - `lib/node-scope/lifecycle.ts`: `ScopeLifecycle` (one per window, `WindowScope.lifecycle`, created on first use): `manage(scope, hooks) → ManagedScope { scope, release() }` with `ManagedScopeHooks { startServices(scope) → stop, setHidden?(scope, hidden), resync?(scope), handoff?(scope) → Promise, toSummary?(scope) }`; `tierOf(nodeId)`, `lastShown(nodeId)`, `shownNodeId`, `size`, `tiers: ReadableSignal<ReadonlyMap<BackendId, NodeScopeTier>>`, `onTransition(listener)` (`TierChange { nodeId, scope, from, to, reason }`), `onScopeOpen(listener)` (summary → warm, before the warm services start), `resume(nodeId)`, `readMemory()`, `estimateBytes()`, `checkPressure() → { reading, steps }`, `relieveMemoryWarning()`, `configure(settings)` (runtime budget or timer changes), `dispose()`. Constants `PRESSURE_RECHECK_MS` (1 s), `MEMORY_WARNING_EVENT` (`orkestrator:memory-warning`). The scope's own `tier` signal follows (`NodeScope.setTier`).
  - `lib/node-scope/lifecycle-config.ts`: `LifecycleHost`, `LifecycleConfig` (`suspendAfterMs` = `NODE_SUSPEND_AFTER_MS`, `suspendWhenDocumentHidden`, `memoryBudgetBytes`, `memorySource` `measured | estimate`, `scopeEstimateBytes`, `suspendedEstimateBytes`, `pressureCheckMs`, `byteBudgets`), `HOST_LIFECYCLE_DEFAULTS`, `lifecycleConfigFor(overrides, host?)`, `detectLifecycleHost(window?)` (iOS from `__orkestratorClientPlatform`, desktop from the preload/gateway, else browser), `pageHeapReader()`.
  - `WindowScopeOptions.lifecycle` (host and overrides) and `.lifecycleDeps` (clock, heap reader, visibility, memory warnings); `WindowScope.lifecycleConfig`; the window's byte budgets now default to the host's (`byteBudgets`), explicit `budgets` still win.
  - `ByteBudget.evictNode(nodeId)` (with `onEvict`), used by the pressure path.
  - `read-coordinator.ts`: `ReadCoordinator.setScopeHidden(hidden)` and `setReadCoordinatorScopeHidden(scope, hidden)` (kept for a coordinator made later), diagnostics `scopeHidden`.
  - `lib/federation/in-tree-scopes.ts`: holds hand the scope to the lifecycle (`readHooks` option for tests); `IN_TREE_RELEASE_GRACE_MS` and `graceMs` are gone.
  - Desktop: `NODE_SCOPE_IDLE_RELEASE_MS` (15 min) in `electron/node-scopes.ts`, passed by `main.ts`.
  - iOS: `RemoteWebView.Coordinator.memoryWarningScript`, `forwardMemoryWarning()`.
  - Log event `web.node-scope` `lifecycle.pressure` (counts and byte totals only).
- **Placeholders (report §8.2 "kept as placeholders", 0004).** desktop: 15 min, measured heap, 1 GiB; browser: 5 min, measured heap, 512 MiB; iOS: 2 min and on `visibilitychange` hidden, the estimate (24 MiB per warm scope, 4 MiB per suspended one, plus every byte-budget reservation) against 128 MiB, and half the byte budgets. Desktop and browser keep `DEFAULT_WINDOW_BYTE_BUDGETS`, so those hosts behave as before for byte budgets. "Measured" is `performance.measureUserAgentSpecificMemory()` where the page is cross-origin isolated (0004 found it unavailable on the hosted page today), else Chromium's `performance.memory.usedJSHeapSize` (Electron, Chrome), else the estimate. Every value is configurable per window and at runtime (`configure`).
- **Decision: what "live" means (2026-11-07).** The §8.1 table counts live as "1 (shown) + recently shown within budget". Options: (a) a hidden node stays `live` while it holds heavy data and turns `warm` when its last reservation goes; (b) `live` is the shown node only, and the "recently shown within budget" part is per entry: a hidden node's transcripts, artifacts and images stay reserved in the window byte budgets, least recently used first, and go when a budget or the pressure path wants the room. Chosen (b), as the item's "Switch away: live → warm. Heavy data is released to the window budgets on demand" says: the tier never goes stale when a budget evicts on its own, and eviction is at data granularity. Pressure step 1 is therefore "drop the heavy data of the least recently shown hidden scope that still holds any".
- **Decision: hidden reads, per node (2026-11-07).** The item says a suspended scope is told it is host-hidden (`setHostHidden`), but `setHostHidden` is window-wide (3014's `ReadWindowPolicy`), so it would pause every node, the shown one included (4001 already avoided it in-tree). Added a per-node flag instead (`setScopeHidden`, outside this item's file set, additive). It is set for every hidden managed scope, warm or suspended, as 0003 does for a hidden realm, and cleared when the node is shown (the coordinator then reconciles as on a visibility return).
- **Decision: resume always resyncs (2026-11-07).** A suspended client detaches its listeners (desktop: main's stream stays open but nothing is delivered; browser: the transport's subscriptions close), so events while suspended are dropped, never queued. On resume the client reattaches, the warm services start again (the change feed re-reads its manifest on attach, so stores re-read authoritative snapshots), and the read coordinator gets a reconnect reconcile (`notifyReadCoordinatorReconnected`). This does not wait for a `gateway.reconcile-required` frame: on the desktop path there is no gap frame, because main's stream never closed, so the frame cannot be the trigger. Invariants 3, 4, 7, 8 hold because the snapshot read starts after the listeners are attached.
- **Decision: attention is handed off before streams close (2026-11-07, from 5001's review).** 5001's window attention listens on a warm/live scope's client and moves a node to the command node's relay when its tier changes, keeping the old source until the relay is live. Suspending closed the client's listeners before the tier changed, so attention raised while the relay lease confirmed would be missed. Now a suspend calls `hooks.handoff(scope)` first (in-tree passes `attentionHandoff(windowScope, nodeId)` from `lib/federation/window-attention.ts`, before the tier changes, because `attentionHandoff` resolves at once for a node it no longer wants on the scope), then sets the tier `suspended` and stops the services, and calls `client.suspend()` only when the handoff settled (bounded by 5001's `ATTENTION_HANDOVER_TIMEOUT_MS`) and only if the scope is still suspended. Disposal to summary needs no handoff: only a suspended scope (streams already closed, attention already on the relay) goes to summary. Tests: `lifecycle.test.ts` "streams close only after the scope's listeners were handed off, and the tier changes first" and `in-tree-scopes.test.ts` "a suspend hands the node's attention off before its client's streams close".
- **Decision: pressure (2026-11-07).** One step at a time, re-reading memory after each: (1) drop heavy data (LRU hidden), (2) suspend (LRU warm), (3) dispose (LRU suspended) back to summary. Never the shown node; the command scope is never managed. A scope is never disposed in the pass that suspended it, so `InTreeWorkspace` has unmounted its views before its stores go; such a pass schedules a recheck after `PRESSURE_RECHECK_MS`. A check during a pass joins it and the pass reads again before it ends. Checks run on manage, on every switch, on `configure`, every `pressureCheckMs` while any scope is managed, and on a memory warning. A memory warning (iOS) is a sweep: every hidden scope drops its heavy data and suspends, and every scope suspended before this warning goes to summary; then a recheck.
- **Decision: iOS hidden (2026-11-07).** On `visibilitychange` hidden every managed scope suspends, the shown one too (the window shows nothing, and WebKit drops connections in the background anyway); visible again resumes the shown node only. Elsewhere a hidden document changes no tier.
- **Decision: the shown node's own older entries (2026-11-07).** 3009 noted that with the shown node protected wholesale, a window showing one node could never evict that node's older sessions for itself. `ByteBudget`'s policy now lets the shown node make room from its own older entries (after other nodes'), never another node from the shown node's. The lifecycle sets `setShownNode` only while it manages a scope, and clears it when the last one goes, so a window with only its command node behaves as before.
- **Decision: 3009's display caches.** The projection display LRU and the progressive cache stay bounded per node instance (not reserved): their history part is the retained pages, which the budget bounds; the rest goes with the scope at summary.
- **Decision: in-tree holds and views (2026-11-07).** The 60 s grace timer is gone: releasing the last hold leaves the scope to its tiers (hidden → warm, suspended on its timer, summary under pressure), so switching back within the suspend time is instant and later is a resume. A scope the module did not open is handed back on summary (client resumed, services stopped) and never disposed. `InTreeWorkspace` mounts the node's views while it is warm, live or shown; a suspended hidden node unmounts them (its light stores stay; the next warm/live opens a fresh document on them, as a realm reload); a node taken back to summary reopens when the window's selection shows it again. The logic follows the scope's `tier`/`health` and the window selection by subscription.
- **Decision: realm caps (2026-11-07).** `remoteWorkspaceStore.open` caps only realm nodes at `MAX_OPEN_REALMS`; in-tree nodes are not counted (their memory is the lifecycle's). `DEFAULT_MAX_VIEWS` caps desktop main's realm `WebContentsView`s, which an in-tree node never has, so it needed no change.
- **Decision: desktop main (2026-11-07).** A renderer-held node scope is released when the renderer disposes its scope (`DesktopNodeClient.dispose` → `orkestrator:nodes:release` → `releaseNodeScope`, regardless of holds), which pressure now drives; reload and window close already release. Main's idle sweep (2006) gets `NODE_SCOPE_IDLE_RELEASE_MS` = the desktop suspend time, for scopes opened only by node-addressed invokes (no hold). Suspension does not drop main's hold: the desktop client's suspend only stops delivery, and a resume needs no reopen.
- **iOS hook: done; its XCTest not run here.** `mise run test:ios` could not run on this host: `xcrun simctl list devices available --json` hangs (the runner's 300 s no-output watchdog ended the suite) because CoreSimulator is out of date for this Xcode ("Current version (1171.7.0) is older than build version (1174.21.0)"). `xcodebuild … -destination 'generic/platform=iOS Simulator' build-for-testing` succeeds (app and test bundle compile), so `testMemoryWarningIsForwardedToThePageUntilTeardown` is built but not run; review preparation should run it on a host with a working simulator. The WebView coordinator already evaluates JavaScript (`evaluateJavaScript`), so the hook is one `NotificationCenter` observer for `UIApplication.didReceiveMemoryWarningNotification` that dispatches `orkestrator:memory-warning` on `window` (no data), removed in `teardown`. The web lifecycle listens on `window` while any scope is managed.
- **Hook points for concurrent items.** 4003: `windowScope.lifecycle.onScopeOpen(scope => …)` runs on summary → warm before the warm services start (paint from the snapshot before the first authoritative read). 5001: `lifecycle.tiers` / `onTransition` / `tierOf(nodeId)` (a node not managed reads `summary`, or `live` for the command scope); a scope disposed elsewhere is reported as a transition to `summary`.
- **Where Effect is used, and where not (2026-11-07).** The tier timers are plain, injectable clock timers, not an Effect `Schedule` or fibers: each is a one-shot delay that every switch re-arms, and the tests drive them with a fake clock like the read coordinator's. The transition machine is a small synchronous state per scope that React reads through the scope's signal; an Effect program would add a runtime boundary with nothing to compose. The cleanup is Effect-backed: each managed scope's entry is torn down by a finalizer on its scope's `Lifetime` (Effect `Scope`), and the window disposes the lifecycle from its own lifetime, registered first so it runs after every node scope has closed.
- **Outside the file set (minimal, additive).** `lib/node-scope/byte-budget.ts` (+ test; `evictNode`, the shown-node rule), `lib/read-coordinator.ts` (+ test; per-node hidden), `stores/remoteWorkspaceStore.ts` (+ new test), `components/federation/InTreeWorkspace.tsx` (+ test), `apps/desktop/electron/main.ts`, `packages/protocol/src/log-vocabulary/web-sync.ts`, `docs/development/node-scopes.md`, `docs/architecture/federation.md`, `apps/ios` (`RemoteWebView.swift`, a test).
- **For the orchestrator (report).** §8.1 could say that `live` is the shown node and "recently shown within budget" is per byte-budget entry; that a suspended scope's reads are told it is hidden per node (not window-wide `setHostHidden`); and that a resume resyncs unconditionally. §8.2's placeholder values now live in `HOST_LIFECYCLE_DEFAULTS`.
- **Aggregate suite** left to review preparation. Running all of `src/components/federation` in one process without `--parallel` fails `InTreeWorkspace.shim-guard.test.tsx` (4004's, in progress) on cross-file state; it passes alone and in the parallel (isolated) run.

## Work log

- 2026-11-07 (claude-worker): added the window's node-scope lifecycle (`lifecycle.ts`, `lifecycle-config.ts`, `WindowScope.lifecycle`) with tiers, `lastShown`, suspend timers per host, the pressure order and the memory-warning path; `ByteBudget.evictNode` and the shown node's own eviction; per-node hidden reads in the read coordinator; in-tree holds on the lifecycle (grace timer removed); `InTreeWorkspace` following the tier; in-tree nodes no longer counted in `MAX_OPEN_REALMS`; desktop idle release time; the iOS memory-warning hook; docs. Tests: `lifecycle.test.ts` (22: each transition, resume with resync over the real listener table, pressure order and the shown node, measured vs estimate, memory warning, iOS hidden, timers on dispose, per-host defaults and overrides, six fake nodes with bounded memory), `in-tree-scopes.test.ts` (9), `byte-budget.test.ts` (+2), `read-coordinator.test.ts` (+2), `remoteWorkspaceStore.test.ts` (2, new), `InTreeWorkspace.test.tsx` (+1: suspended unmount, summary reopen), desktop `node-scopes.test.ts` (+1), iOS `testMemoryWarningIsForwardedToThePageUntilTeardown` (builds; not run: CoreSimulator is out of date on this host). Then, after 5001's review, the attention handoff before a suspend closes streams (+1 lifecycle, +1 in-tree test). Focused runs pass: web `src/components/federation src/lib/federation src/lib/node-scope src/stores/remoteWorkspaceStore.test.ts src/lib/read-coordinator.test.ts` and `src/lib src/stores src/hooks` (parallel), desktop `node-scopes`/`node-ipc` (all pass). Web and desktop typechecks clean in this item's files (the only web error is in another agent's `lib/portal/machine-scope.test.ts`); fmt and oxlint clean.
