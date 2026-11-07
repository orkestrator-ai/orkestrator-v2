---
id: 0004
title: "Measure what the budgets and transport choices need"
phase: 0
plan: "§8.2, §12 Phase 0.4 and §15"
status: in-progress
depends_on: []
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 0004 · Measure what the budgets and transport choices need

- **Report:** [§8.2 Budgets per host](../../docs/reports/unified-federation.md#82-budgets-per-host), [§15](../../docs/reports/unified-federation.md#15-not-done--needs-live-evidence)
- **Depends on:** none
- **Blocks:** [4002](4002-hydration-tiers-and-budgets.md) (budget defaults) and [5005](5005-multiplexed-relay-stream.md) (whether it is needed at all)
- **Parallel with:** everything
- **Size:** S–M (mostly live work)
- **Track:** F (fixes now)

## Goal

Replace the placeholder numbers in §8.2 and the "inferred" claims in §15 with observed values. The result is a dated report under `docs/reports/`.

## Current state (verified 2026-11-07)

- Desktop has no memory instrumentation. There is no `app.getAppMetrics`, `getProcessMemoryInfo` or `process.memoryUsage` anywhere in `apps/desktop`.
- The web app has no `performance.measureUserAgentSpecificMemory`.
- Boot metrics already report `nextHopProtocol` (`web-gateway.ts:602-663` → `/__orkestrator/client-metrics`, `apps/backend/src/gateway-support-core.ts:866`).
- Realm cold-open timing already exists:
  - `packages/protocol/src/realm-boot-timing.ts`
  - `apps/web/src/lib/realm-boot-timing.ts`
  - logged by main in `apps/desktop/electron/workspace-realm-messages.ts` with `sinceOpenMs`
  - This is desktop only; a browser frame logs to the console.
- iOS handles only `webViewWebContentProcessDidTerminate` (`apps/ios/OrkestratorMobile/Views/RemoteWebView.swift:432-435`).
- Todo `docs/todo/transcripts-and-observation/5380-bearer-terminal-stream-live-evidence.md`, task 2, already asks which routes use HTTP/1.1.

## Work

- [x] Add a development-only diagnostic command or log line in desktop main that samples `app.getAppMetrics()` per process type, and labels each realm view by node id hash (never a token). Keep it out of production builds, or behind a debug setting.
- [x] Desktop, with leaves attached: record per-realm process memory idle, with a terminal open and with an (empty) agent tab open, for 1, 3 (renderer cap) and 4 (main cap) realms.
- [ ] Desktop: per-realm memory with a non-empty transcript open (needs a provider turn or a seeded transcript), and on a packaged build rather than the development renderer.
- [x] Browser, Chromium: heap and renderer RSS per iframe realm with 1, 2 and 3 realms and 6 nodes attached (`measureUserAgentSpecificMemory` unavailable: not cross-origin isolated; CDP heap usage after GC instead). Playwright WebKit measured as a proxy.
- [ ] Browser, Safari itself (only Playwright WebKit was available here).
- [ ] iPad: WebContent process memory with 1, 3 and 6 realms, and the point where jetsam kills it (Xcode memory gauge or Instruments). Not done: no iPad reachable from this host.
- [x] Request rate from a hidden browser realm, before and after [0003](0003-hidden-realm-visibility.md).
- [x] Whether a hidden desktop `WebContentsView` reports `visibilityState: hidden` and throttles timers.
- [x] `nextHopProtocol` on direct loopback and the relay (both `http/1.1`).
- [ ] `nextHopProtocol` on direct LAN and Tailscale Serve; then close 5380 task 2 with the answer.
- [x] Count long-lived requests per origin with a window plus three relayed realms, to confirm or refute P5 (connection exhaustion).
- [x] Cold-open time to first paint on this Mac (desktop development build, Chromium, WebKit), from the existing boot timing.
- [ ] Cold-open time on other hosts (Linux, iPad, real LAN/tailnet latency).
- [x] Write `docs/reports/unified-federation-measurements.md` with the date, commit, hosts, method and numbers. Link it from the report and from this item.

## Done when

- [x] The report exists. §8.2's table is either replaced with measured defaults or marked "kept as placeholder" with the reason. (Marked kept as placeholder in the report's §8.2 on 2026-11-07.)
- [x] A recommendation on [5005](5005-multiplexed-relay-stream.md) (needed or not) is recorded.

## Notes

- Measurements must not include prompts, transcript or terminal contents, or tokens (invariant 12). Screenshots of DevTools should crop to the numbers.
- Report: [unified-federation-measurements.md](../../docs/reports/unified-federation-measurements.md) (2026-11-07, one Mac, loopback). One link line was added to the design report's §15.
- Not done: no iPad reachable from this host, so the iPad box stays open and §8.2 cannot get iOS numbers. The Done-when's §8.2 change is the orchestrator's (the report is owned there); the measurements report recommends marking §8.2 "kept as placeholder" (desktop numbers are from a development renderer, no iPad, per-realm cost is not per-scope cost), so that box stays open. *(2026-11-07, orchestrator, completeness check: stale. The orchestrator marked §8.2 "kept as placeholder" in the report the same day and the Done-when box is ticked; only the measurement boxes (packaged/transcript desktop, Safari, iPad, LAN/Tailscale `nextHopProtocol`, other hosts' cold open) stay open.)*
- Diagnostic: `apps/desktop/electron/process-memory-diagnostic.ts`, wired in `main.ts`; `WorkspaceViews.realmProcesses()` exposes each realm's node, visibility and renderer pid. Gate: `processMemoryDiagnosticInterval(isDev, env)` returns null unless development mode and `ORKESTRATOR_DEV_PROCESS_MEMORY_MS` is a whole number (clamped to 1 s–10 min). Log events `desktop` `process-memory`, `process-memory.realm` (node = `connectionPartitionKey(nodeId)`, the partition hash), `process-memory.failed`, added to the log vocabulary. Options considered: an IPC command the renderer can call (rejected: a new IPC surface for a dev tool, and a renderer would have to be trusted to ask), a debug setting in the UI (rejected: reaches production builds), an env-gated dev-only interval log (chosen: no production code path, no new surface, works headless). Effect not used: an unref'd interval and a pure summariser; nothing here is an effect pipeline.
- Key findings: P5 confirmed and worse than estimated (two relayed realms exhaust Chromium's six HTTP/1.1 connections on the command node's origin; the window's own requests then wait); 5005 recommended as needed for HTTP/1.1 relays. A hidden desktop `WebContentsView` reports visible and is not throttled. A desktop realm (development build) is 340-410 MB; a Chromium iframe realm 22-33 MB JS heap, 60-90 MB RSS; WebKit keeps all realms in one WebContent process.

## Work log

- 2026-11-07 (claude-worker): added the development-only process memory diagnostic (`112938cd5`, 10 unit tests). Live: two `dev:test` profiles plus five extra leaves (browser), a Playwright-launched Electron command node with four leaves (desktop), Chromium over CDP and Playwright WebKit. Measured desktop and browser memory per realm, hidden-realm request rate before/after 0003, WebContentsView visibility and timers, `nextHopProtocol` on loopback direct and relay, long-lived requests per origin with 1-3 relayed realms, cold-open times. Wrote the measurements report. Left open: iPad, Safari proper, LAN/Tailscale Serve protocol, non-empty transcript and packaged-build desktop memory, other hosts, and the §8.2 edit (orchestrator).
- 2026-11-07 (orchestrator): marked §8.2 "kept as placeholder" in the design report with the reason (per-realm costs measured, not per-scope; iPad and packaged numbers missing), and recorded the observed results in §15 and P5. The iPad and Safari boxes stay open: no iPad or Safari is reachable from this host.
- 2026-11-07 (orchestrator, completeness check): marked the Notes' "so that box stays open" (§8.2) stale: §8.2 is marked kept as placeholder and the Done-when box is ticked. Measurement boxes stay open for the hosts this machine cannot reach.
