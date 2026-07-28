# Milestone 0 — Baseline, instrumentation, and rollout controls

Status: In progress

Depends on: none

Unblocks: all later milestones

## Outcome

Establish privacy-safe measurements and compression rollout controls before
changing network behavior. This milestone must not enable response compression
in production.

## Scope

Primary files:

- `apps/backend/src/gateway.ts`
- `apps/backend/src/options.ts`
- `apps/web/src/lib/native/web-gateway.ts`
- `apps/ios/OrkestratorMobile/Views/RemoteWebView.swift`
- `docs/remote-gateway.md`
- gateway option and documentation tests

## Implementation checklist

### Baseline measurements

- [ ] Record cold and warm load bytes and timings for a desktop browser.
- [ ] Record cold and warm load bytes and timings for a real iPhone or iPad
      `WKWebView`.
- [ ] Record raw, gzip, and Brotli sizes of the main JavaScript and CSS assets.
- [ ] Record invoke count, request bytes, response bytes, and duration by
      command.
- [ ] Record gateway and bridge event frames and bytes by event type.
- [ ] Record terminal input request count, raw bytes, wire bytes, and
      key-to-visible-echo latency.
- [ ] Record open, connecting, dropped, and stalled stream counts.
- [ ] Record reconnects, replay hits, cursor expirations, and full
      reconciliations where those values already exist.
- [ ] Record the HTTP version and encoding headers seen through raw tailnet HTTP
      and Tailscale Serve.

### Privacy-safe instrumentation

- [x] Add response byte and encoding counters by route.
- [x] Add invoke counters by command without recording arguments or results.
- [x] Add stream lifecycle and dropped-client counters.
- [x] Add compression timing hooks that later milestones can populate.
- [x] Add browser boot milestones and resource transfer-size collection.
- [x] Confirm no metric contains prompts, terminal output, file contents,
      attachment data, credentials, or tokens.
- [x] Bound or sample any in-memory metric labels with unbounded cardinality.

### Rollout controls

- [x] Add `compression?: "off" | "body" | "on"` to gateway options.
- [x] Resolve constructor configuration before
      `ORKESTRATOR_GATEWAY_COMPRESSION`.
- [x] Add `--compression <mode>` to backend CLI parsing.
- [x] Default to a mode that leaves existing behavior unchanged in this
      milestone.
- [x] Gate future compression on `listenerKind`, never on the bind address.
- [x] Ensure the Electron control listener always remains identity.
- [x] Reject invalid configuration values with an actionable error.
- [x] Document the option, environment variable, defaults, and rollback modes in
      `docs/remote-gateway.md`.

## Required tests

- [x] Constructor option overrides the environment variable.
- [x] CLI parsing accepts `off`, `body`, and `on`.
- [x] Invalid compression modes fail clearly.
- [x] The control listener resolves to identity in every mode.
- [x] A browser listener bound to loopback under Tailscale Serve is still
      treated as remote.
- [x] Documentation assertions in
      `tests/unit/docs/remote-gateway-docs.test.ts` pass.

## Manual verification

Test Electron, a desktop browser, and a real iOS device:

- [ ] Application behavior is unchanged with compression set to `off`.
- [ ] Metrics appear for cold load, warm load, an invoke, an event stream, and a
      terminal session.
- [ ] Inspect representative metric output and confirm it contains no user
      content.
- [ ] Start work in environment A, switch to B, let A progress, and confirm A
      rehydrates correctly when revisited.

## Commands

```bash
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/desktop typecheck
bun test tests/unit/electron/gateway.test.ts --parallel
bun test tests/unit/docs/remote-gateway-docs.test.ts --parallel
```

## Exit criteria

- [ ] Desktop web and real-device iOS baseline results are recorded below.
- [ ] Instrumentation covers the agreed success measures without user content.
- [ ] Compression modes are parsed, documented, and tested.
- [ ] No production response path has changed encoding yet.
- [ ] The control listener remains byte-for-byte identity.
- [ ] Focused tests and typechecks pass.

## Evidence and decisions

Record:

- baseline date, commit, Bun version, browser/device versions, and link shape;
- cold/warm transfer totals and boot timings;
- terminal request rate and latency;
- stream/reconciliation counts;
- any metric intentionally deferred and why;
- test command results.

Recorded Tuesday, July 28, 2026:

- Implemented privacy-safe gateway counters and recent bounded samples for
  routes, commands, event frames, stream lifecycle, and client boot/resource
  timings in `apps/backend/src/gateway.ts`.
- Added authenticated `GET /__orkestrator/metrics` and
  `POST /__orkestrator/client-metrics` endpoints for milestone measurements.
- Added browser boot/resource reporting in
  `apps/web/src/lib/native/web-gateway.ts` and explicit `WKWebView` platform
  tagging in `apps/ios/OrkestratorMobile/Views/RemoteWebView.swift`.
- Added `compression?: "off" | "body" | "on"` to gateway construction, wired
  `--compression` and `ORKESTRATOR_GATEWAY_COMPRESSION`, and kept the default
  at `off` so production response encoding remains unchanged.
- Metric labels are bounded by route classification, terminal event-name
  normalization, bounded recent samples, and overflow buckets for excess
  command/event keys.
- Pending manual work: desktop cold/warm baselines, real iPhone/iPad
  `WKWebView` baselines, main asset raw/gzip/Brotli measurements, inactive-tab
  rehydration verification, and final exit-criteria signoff.
- Test command results:
  `bun run --cwd apps/backend typecheck`
  `bun run --cwd apps/web typecheck`
  `bun test apps/backend/src/options.test.ts tests/unit/electron/gateway.test.ts apps/web/src/lib/native/web-gateway.test.ts tests/unit/docs/remote-gateway-docs.test.ts --parallel`
