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
- [x] Resolve standalone configuration as CLI, then environment, then `off`.
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
- [x] CLI compression overrides the environment and absent configuration
      defaults to `off`.
- [x] Invalid compression modes fail clearly.
- [x] `off`, `body`, and `on` do not add response compression in this
      milestone.
- [x] The control listener resolves to identity in every mode.
- [x] A browser listener bound to loopback under Tailscale Serve is still
      treated as remote.
- [x] Both metrics routes require authentication and enforce their documented
      `GET`/`POST` methods.
- [x] Client metric reports are allowlisted and bounded, and metric labels do
      not retain unknown commands or arbitrary response encodings.
- [x] The command label budget holds the entire backend command registry.
- [x] Header, protocol, and label normalizers are covered directly, including
      `q=0` refusals, absent protocols, and UTF-8 truncation boundaries.
- [x] Stream gauges survive a drop, a close, and a failed handshake without
      double-counting.
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
- [x] Instrumentation covers the agreed success measures without user content.
- [x] Compression modes are parsed, documented, and tested.
- [x] No production response path has changed encoding yet.
- [x] The control listener remains byte-for-byte identity.
- [x] Focused tests and typechecks pass.

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
- Metric labels are bounded by route classification, per-entity event-name
  collapsing, bounded recent samples, and overflow buckets for excess
  command/event keys. Unknown commands and uncommon response encodings use
  fixed buckets instead of retaining network-controlled labels.
- Command labels are gated on backend registry membership rather than on the
  registry's error text, so a rejected name is never retained even when
  `invoke` refuses before consulting the registry. The command budget is sized
  above the registry so no registered command is lost to `__overflow__`.
- Event names that embed an identifier (`terminal-output-<id>`,
  `claude-state-<containerId>`) collapse to fixed categories, so per-entity
  names cannot evict genuine event labels.
- Event counters are per delivery: `wireBytes` is the bytes actually written,
  and an emit with no matching subscriber records nothing.
- `Accept-Encoding` tokens weighted `q=0` are refusals and are not recorded as
  support, and an unavailable `nextHopProtocol` stays `null` rather than
  collapsing into `other`.
- Pending manual work: desktop cold/warm baselines, real iPhone/iPad
  `WKWebView` baselines, main asset raw/gzip/Brotli measurements, inactive-tab
  rehydration verification, and final exit-criteria signoff.
- Automated coverage includes configuration precedence/defaults, all three
  no-op modes, listener-role semantics, metrics authentication/method handling,
  input sanitization and bounds, label cardinality, and documentation
  assertions. The coordinated gateway/docs, backend option/standalone,
  browser-client, and iOS suites pass, as do the backend, web, and desktop
  typechecks and both production build targets.
