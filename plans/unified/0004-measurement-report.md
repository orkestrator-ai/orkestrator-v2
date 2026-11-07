---
id: 0004
title: "Measure what the budgets and transport choices need"
phase: 0
plan: "§8.2, §12 Phase 0.4 and §15"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
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

- [ ] Add a development-only diagnostic command or log line in desktop main that samples `app.getAppMetrics()` per process type, and labels each realm view by node id hash (never a token). Keep it out of production builds, or behind a debug setting.
- [ ] Desktop, on a `dev:test` profile with leaves attached: record per-realm process memory idle, with a transcript open, and with a terminal open. Record it for 1, 3 and the cap of realms.
- [ ] Browser (Chromium and Safari): heap per iframe realm with 1, 3 and 6 nodes. Use `performance.measureUserAgentSpecificMemory` where cross-origin isolation allows it, otherwise the DevTools heap snapshot.
- [ ] iPad: WebContent process memory with 1, 3 and 6 realms, and the point where jetsam kills it (Xcode memory gauge or Instruments).
- [ ] Request rate from a hidden browser realm, before and after [0003](0003-hidden-realm-visibility.md).
- [ ] Whether a hidden desktop `WebContentsView` reports `visibilityState: hidden` and throttles timers.
- [ ] `nextHopProtocol` on real routes: direct LAN, Tailscale Serve and the relay. Close 5380 task 2 with the answer.
- [ ] Count long-lived requests per origin with a window plus three relayed realms, to confirm or refute P5 (connection exhaustion).
- [ ] Cold-open time to first paint per host, from the existing boot timing.
- [ ] Write `docs/reports/unified-federation-measurements.md` with the date, commit, hosts, method and numbers. Link it from the report and from this item.

## Done when

- [ ] The report exists. §8.2's table is either replaced with measured defaults or marked "kept as placeholder" with the reason.
- [ ] A recommendation on [5005](5005-multiplexed-relay-stream.md) (needed or not) is recorded.

## Notes

- Measurements must not include prompts, transcript or terminal contents, or tokens (invariant 12). Screenshots of DevTools should crop to the numbers.
