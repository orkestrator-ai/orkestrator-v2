# Service preview rollout

Checked against `main` at `2459b05c` (2026-10-15).

Service previews shipped in #831 (`4f02156b`). Each previewed application gets
a backend-owned service identity, carried by a desktop tunnel, private HTTPS
origins or an optional container relay. Every new transport ships off by
default. The only real-stack evidence is a single-machine Linux and Chromium
run from 2026-09-23. This file covers four things: the platform runs each
transport needs before it is advertised or enabled, the criteria for flipping
defaults, the later retirement of the legacy loopback route and its shared
partitions, and the evidence log where run results are now recorded.

## Current state

- Defaults: `DEFAULT_PREVIEW_SETTINGS`
  (`apps/backend/src/core/storage-preview-services.ts`) sets
  `transport: false`, `relay: false` and `publication.enabled: false`.
  `PreviewRuntime.effectiveSettings` (`core/preview-runtime.ts`) applies the
  `ORKESTRATOR_PREVIEW_TRANSPORT` and `ORKESTRATOR_PREVIEW_RELAY` overrides.
  Since #969, settings, definitions and identity are the SQLite stores
  `preview-settings`, `preview-services` and `backend-identity`
  (`core/storage-stores.ts`), imported once from the old JSON files.
- These are always on, whatever the settings: the registry and the legacy path
  (`PreviewRuntime.capabilities`), service tabs opened from the environment
  button (`environmentBrowserTarget`), and terminal-link intents
  (`linkBrowserTarget`, both in `apps/web/src/lib/preview-service-entry.ts`).
  Without the tunnel, `ServiceBrowserTab` falls back on desktop to
  `"compatibility"` mode: it loads the service's current host port over the
  legacy route.
- The legacy route is `/__orkestrator/browser/loopback/<port>/`
  (`GatewayProxy.proxyToTarget`, `apps/backend/src/gateway-proxy.ts`). It
  rewrites HTML (`rewriteBrowserPreviewBody`). It rewrites cookie paths
  (`rewriteSetCookieHeader`), which breaks `__Host-` cookies. It strips CSP and
  X-Frame-Options, recovers root-relative requests from the `Referer`
  (`browserPreviewRefererPrefix`), has no WebSocket support, and puts every
  application on one origin. #831 bounded it with `legacyPreviewAdmission`,
  header deadlines and a `no-transform` check. It serves old clients, legacy
  URL tabs (`BrowserTab` with `target.kind === "url"`), service tabs in
  compatibility mode, and annotations on legacy URL tabs.
- Partitions (`apps/desktop/electron/desktop-window-lifecycle.ts`): legacy URL
  tabs share `browserPreviewPartitionForWindow`, one per window slot and
  connection. Each service gets `browserPreviewServicePartition`
  (`persist:orkestrator-preview-svc-<slot>-<connection>-<hash>`). Only an
  explicit `PreviewTransportManager.resetSiteData` clears one. Nothing is
  cleared when a service is removed, an environment deleted, or a connection
  forgotten (`forgetConnection` in `main.ts`). Legacy URL tabs are never
  converted to service tabs.
- Tests: the only real browser is Chromium. `e2e/preview/private-origin.spec.ts`
  has six tests on an isolated stack (`apps/backend/src/preview-browser-harness.ts`,
  throwaway CA). Its config has no `projects`, and sibling isolation checks
  only localStorage and cookies. The opt-in Docker, relay, Vite and benchmark
  suites are listed in [`testing-guide.md`](../development/testing-guide.md)
  §"Opt-in preview checks". They have no mise task and do not run in CI. No
  real-Electron spec opens a service preview: `testMatch` in
  `e2e/agent-testing/playwright.electron.config.ts` lists only
  `electron-main`, `web-annotations-electron` and
  `terminal-input-resume-electron`. None of these suites has been re-run since
  #831.

## Outstanding work

### Code

1. A real-Electron service-preview spec under `e2e/agent-testing/` (for example
   `service-preview-electron.spec.ts`), reusing the Electron harness and
   `test-fixtures/preview-app`. Add it to `testMatch` in
   `playwright.electron.config.ts`.
2. A hostile service-worker route in `test-fixtures/preview-app/server.ts`
   that registers a worker intercepting `/__orkestrator_preview/session`.
3. Relay fault tests for an oversized frame (handled in
   `EnvironmentRelay.onData`) and a protocol-version mismatch (the relay
   script exits). Stdin errors, a silent relay and a wrong nonce are already
   covered.
4. Diagnose or fix the open preview flakes
   [0184](../tests/flaky-tests/0184-preview-tunnel-stopped-reader-queue.md),
   [0195](../tests/flaky-tests/0195-preview-handoff-container-reconciliation.md)
   and [0221](../tests/flaky-tests/0221-preview-first-chunk-timing.md).
5. Optional: Playwright `firefox` and `webkit` projects in
   `playwright.preview.config.ts`, as early signal only (not Safari or iOS
   evidence). Optional: new mise tasks for the opt-in suites (for example
   `test:preview:docker` and `test:preview:browser`), with `testing-guide.md`
   updated to use them.
6. Partition retention. Electron has to own this, because the backend knows
   nothing about client partitions.
   - Clear a service's partition when its definition is removed or its
     environment deleted. Reconcile against the `tombstones` that
     `get_preview_services` returns. The window is bounded
     (`PREVIEW_LIMITS.tombstoneRetention` is 256, and `tombstoneFloor` marks
     its start), so a client whose cursor is older must diff against the full
     definition list.
   - Clear a connection's partitions when the connection is forgotten.
   - Once legacy URL tabs are retired, set a retention window for the shared
     window/connection partitions, then clean up only partitions this install
     created.
7. Optional: when a legacy URL tab's port maps unambiguously to a current
   service in the same environment and generation, offer "Open as service".
   Keep ambiguous tabs as they are, with "Choose service". Never infer
   ownership from the port alone or from which environment is active.
8. After the support window (see Open questions), remove compatibility mode
   from `ServiceBrowserTab` and retire the legacy route and its rewrite
   helpers, as a separate reviewed change.
9. Reword the comments that cite deleted plan steps or the old evidence log:
   `PREVIEW_LIMITS` (`packages/protocol/src/preview-services.ts`),
   `preview-header-policy.ts`, and in `apps/backend/src/`
   `core/preview-access.ts`, `core/preview-target-resolver.ts`,
   `core/preview-readiness.ts`, `core/preview-docker.test.ts` and
   `preview-bench.test.ts`.

### Qualification

Each run gates a default or an advertisement. Record every run in the evidence
log below.

- Re-baseline on current main. Run the opt-in commands from
  `testing-guide.md` and all preview unit files. The 2026-09-23 file lists are
  stale: #966 moved the Electron tests to `apps/desktop/tests/`, #967 moved the
  protocol tests to `packages/protocol/src/node/`, and #969 replaced storage.
- Real Electron window. Gates the desktop tunnel default. Run in an isolated
  profile with `ORKESTRATOR_PREVIEW_TRANSPORT=1`, through code item 1 and
  `mise run test:agent:electron`, or by hand. Cover:
  - no cookie, localStorage, IndexedDB or service-worker crossing between two
    services, or between windows on different backends;
  - ingress header injection for HTTP and WS;
  - zoom, overlays, DevTools, annotations, screenshots, clipboard and history
    after reattach;
  - hide or unmount during HMR, then reattach;
  - renderer crash and reload, and a connection switch;
  - stable resource counts over repeated open, hide and close;
  - keyboard and narrow-viewport use of the picker, service dialog and
    diagnostics.
- Two-machine tailnet. Gates remote desktop previews by default. No runbook
  exists, so write one first. Cover:
  - a decoy on the client machine that no request ever reaches;
  - real-latency baselines for the direct, legacy, tunnel and private-origin
    routes;
  - a throttled link (queues stay bounded);
  - network loss and reconnect;
  - publication reached from the second machine.
- Real private DNS and certificates. Gates publication, one support row per
  deployment type. Use split DNS or a private zone with a wildcard
  certificate, with and without a Tailscale Serve forwarder (`publicPort`).
  Cover renewal, expiry, hostname mismatch and unknown Host (421).
- Firefox, Safari and iOS, top-level. In Firefox and Safari, cover bootstrap,
  sibling isolation, the `fixture.v1` subprotocol and revocation. Run the iOS
  handoff (`create_preview_handoff_url`, contract-tested only in
  `tests/unit/ios-mobile-contracts.test.ts`) on a device or simulator:
  opening in Safari, background and foreground, and private browsing.
  Embedded surfaces are in [embedded-service-previews.md](embedded-service-previews.md).
- Docker Desktop on macOS and Windows: resolver binding inspection, Auto host
  ports, recreation onto a reused port, and the `docker exec` relay.
- Hostile service worker (needs code item 2). Bootstrap and re-bootstrap with
  the worker installed. The documented outcome is that re-sign-in is blocked
  until site data is cleared, and that no other service and no control
  authority is ever reached.
- Compatibility cases not yet run in a real browser:
  - a streaming or router framework fixture alongside the pinned Vite 7.3.6;
  - SPA deep links and history;
  - the `srcset` route (served, never asserted);
  - source maps;
  - OAuth-style external redirects;
  - IndexedDB, BroadcastChannel, service-worker and Cache isolation;
  - popup and frame denial (unit tests only);
  - an IPv6-only target (resolver level only).
- Performance thresholds. Set them from the two-machine baseline (first byte,
  connect time, HMR delivery, peak queue and decode bytes, socket counts)
  before any cohort counts as passing. `PreviewMetrics`
  (`apps/backend/src/preview-metrics.ts`) has `http.connect_ms`,
  `http.first_byte_ms` and `tunnel.open_ms` histograms but nothing for HMR
  delivery or reconnects.

### Enabling defaults

- Desktop tunnel: change `DEFAULT_PREVIEW_SETTINGS.transport` to `true` only
  after the real-Electron and two-machine runs pass and an observation window
  with error and resource thresholds is recorded here. An absence of
  complaints is not a metric.
- Publication cannot be a default: it needs an operator-provided domain,
  certificate, key and listen address. It stays a per-deployment opt-in, gated
  by the DNS and certificate run for that deployment type.
- Relay: default-on needs the Docker Desktop run and documented image
  requirements (`node` or `bun`, and the `node` user).
- Every flip keeps the rollback drill passing
  (`apps/backend/tests/gateway-preview.test.ts`, "rollback drill").

### Evidence log

For each run, record the commit, platform and versions, effective
capabilities and opt-in variables, exact commands, counts, skipped cases with
reasons, and cleanup of profiles, CAs and containers. A row not run keeps the
capability it gates off or unadvertised.

2026-09-23, the #831 change set (merged as `4f02156b`). This is the current
baseline.

| Item | Version |
| --- | --- |
| Host | Linux 7.2.5 (x86_64), one machine |
| Bun | 1.4.2 |
| Node (host / container image) | 26.7.0 / 24.21.0 |
| Docker | Engine 29.7.2 on Linux (not Docker Desktop); `orkestrator-v2:latest`, local build |
| Browser | Chromium headless shell 153.0.8010.12 (Playwright 1.63.0) |
| Vite fixture | 7.3.6, isolated copy at `/tmp/preview-vite` |

- Opt-in variables: `ORKESTRATOR_TEST_DOCKER_PREVIEW_IMAGE` and
  `ORKESTRATOR_TEST_DOCKER_RELAY_IMAGE` (both `orkestrator-v2:latest`),
  `ORKESTRATOR_TEST_PREVIEW_VITE_DIR`, `ORKESTRATOR_PREVIEW_BENCH=1`.
- Counts: protocol 57, backend 91 (11 preview files, opt-in gates on), root
  and Electron unit 136, web 41, real Chromium 6, all passing.
  `mise run check` passed. No containers were left behind.
- Passed: same-port containers with a host decoy, recreation onto a reused
  port, rotation, revocation and the rollback drill with an SSE stream,
  streaming and binary bodies, 304/206, duplicate `Set-Cookie`, compressed
  passthrough, HTTPS upstream verification, tunnel, relay and probe bounds,
  and credential-free logs. Electron partitions, close/reopen cycles and the
  local-worktree journey passed at unit or socket level only.
- Not run: two machines; Firefox, Safari, WKWebView and iOS; Docker Desktop; a
  real Electron window; real private DNS and certificates; a hostile service
  worker.
- Loopback latency from `preview-bench.test.ts`: one fresh connection and one
  `GET /health` per sample, time to the first response byte, 200 samples after
  10 warm-ups. It shows fixed per-connection overhead, not tailnet latency.
  The legacy route was not measured.

  | Route | p50 (ms) | p95 (ms) |
  | --- | --- | --- |
  | Direct TCP to the fixture | 0.31 | 0.37 |
  | Desktop tunnel (WS, HELLO, OPEN, request) | 1.02 | 1.19 |
  | Private origin (TLS handshake and request) | 2.11 | 2.62 |

## Constraints and rationale

- The threat boundaries, the credential and data path, and the resource-owner
  table are in the
  [decision record](../improvements/browser/plan/01-decision-record.md).
  Every change must keep them. In short: application code is untrusted
  relative to control and to other services; local ingress is credentialed
  (port secrecy is not authentication); the tunnel cannot choose
  destinations; gateway credentials never travel inside application bytes;
  Chromium sandboxing is not a firewall.
- A result on one platform never covers another. WebKit on Linux is not
  Safari, and Docker Engine is not Docker Desktop. Use isolated profiles,
  throwaway PKI and owner labels, and never point old and new backends at one
  data directory.
- Invariants: inactivity or unmount never cancels application work;
  snapshots are authoritative; ambiguous writes and WS messages are never
  retried transparently; every queue is bounded and has an overload action;
  logs and metrics never hold URLs, queries, contents or credentials.
- Never copy shared-partition data into service partitions; that would
  reintroduce contamination. Reset is per service and never runs on tab
  switch. Disabling the transport never silently falls back across an
  authorization failure, and compatibility mode shows its limitations.
- Scope that stands: remote machines must run an Orkestrator backend. Managed
  SSH forwarding, remote pixel streaming and an Electron session proxy were
  rejected. There is no public relay or Tailscale Funnel, and only HTTP/1.1
  and WebSockets are carried.
- Mixed versions: old clients show service URIs unchanged and refuse them
  (`browser-address.test.ts`). Pre-#831 backends reject Auto mappings
  (`hostPort: 0`).

## Open questions

- How long is the support window for the legacy route and the pre-preview
  layout schema? Should compatibility mode remain as an explicit fallback
  after the desktop default flips?
- Is it acceptable that annotations on legacy URL tabs keep needing the legacy
  route?
- What observation window and thresholds apply to each cohort, and who signs
  off?
- Should the Chromium preview spec or the Docker suites join a regular gated
  run?

## Needs verification

- Whether the opt-in suites still pass on main after #966, #967 and #969.
- Whether `mise run test:agent:electron` starts cleanly on the run host. An
  earlier Electron startup failure that blocked design-canvas runs was fixed
  (#840), and #986 added an Electron spec on 2026-10-15.
- How much disk the `orkestrator-preview-svc-*` partitions take on a
  long-lived profile, which decides how urgent retention is.

## Related

- [browser-previews.md](../architecture/browser-previews.md) (operator guide),
  [remote-gateway.md](../architecture/remote-gateway.md) §"Service previews".
- [embedded-service-previews.md](embedded-service-previews.md),
  [preview-service-discovery.md](preview-service-discovery.md),
  [web-annotation-qualification.md](web-annotation-qualification.md) (same
  Electron harness; annotations run inside service tabs).
- [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md)
  for batching the macOS, Electron, two-machine and Safari runs;
  [container-platform-qualification.md](container-platform-qualification.md)
  for Docker Desktop.
- [container-network-and-credential-isolation.md](container-network-and-credential-isolation.md):
  egress policy must keep published loopback ports and relay stdio working.
- [mixed-version-compatibility.md](mixed-version-compatibility.md) (support
  window), [environment-and-disk-cleanup.md](environment-and-disk-cleanup.md)
  (deletion-time cleanup), [test-suite-and-ci-health.md](test-suite-and-ci-health.md)
  (gated runs).
- Living-doc drift to fix:
  - `browser-previews.md` status line: says "Implemented on branch …" and
    links the deleted plan index. It shipped as #831; outstanding work is here.
  - `browser-previews.md` §Identity, §"Operator controls" and §"Schema
    downgrade" name `backend-identity.json`, `preview-services.json` and
    `preview-settings.json`, and say older backends ignore `preview-*.json`.
    Since #969 they are SQLite stores, so the downgrade note needs rewriting.
    `docs/plans/environment-deletion-cleanup.md` repeats the
    `preview-services.json` name.
  - `browser-previews.md` §"Framework configuration" says Vite HMR in a real
    browser "has not been validated". The Chromium spec passed it on
    2026-09-23; only the tunnel in a real Electron window is unvalidated.
  - `browser-previews.md` opening ("With everything off, the product behaves
    as before") is only partly true: service tabs, terminal intents and
    registry seeding are always on, and only the transport is legacy.
  - `browser-previews.md` §"Known limitations" and `testing-guide.md`
    ("Record results in `docs/improvements/browser/plan/evidence.md`") should
    point to the evidence log here.

## Replaces

- `docs/improvements/browser/README.md` (findings status, leftovers)
- `docs/improvements/browser/current-state.md` (legacy-route limitations)
- `docs/improvements/browser/proposal.md` §2 (rejected transports), §3
  (storage retention)
- `docs/improvements/browser/validation.md` (acceptance matrix)
- `docs/improvements/browser/plan/00-index.md` (decisions, invariants)
- `docs/improvements/browser/plan/01-architecture-and-fixtures.md` (second
  framework, second machine)
- `docs/improvements/browser/plan/02-contracts-and-capabilities.md` (done)
- `docs/improvements/browser/plan/03-service-registry-and-lifecycle.md` (done)
- `docs/improvements/browser/plan/04-target-resolution-and-readiness.md`
  (Docker Desktop)
- `docs/improvements/browser/plan/05-scoped-authentication.md` (hostile
  worker, Firefox, Safari)
- `docs/improvements/browser/plan/06-http-forwarding.md` (done)
- `docs/improvements/browser/plan/07-websocket-and-tunnel-transport.md`
  (two-machine and throttled runs)
- `docs/improvements/browser/plan/08-electron-transport-and-isolation.md`
  (real window, partition retention)
- `docs/improvements/browser/plan/09-client-resolution-and-migration.md`
  (legacy tab migration, Electron reload)
- `docs/improvements/browser/plan/10-private-preview-origins.md` (real DNS
  and certificates)
- `docs/improvements/browser/plan/11-web-external-and-ios-clients.md`
  (top-level Firefox, Safari, iOS)
- `docs/improvements/browser/plan/12-service-controls-and-diagnostics.md`
  (keyboard and narrow viewport)
- `docs/improvements/browser/plan/13-optional-container-relay.md` (Docker
  Desktop, fault tests)
- `docs/improvements/browser/plan/14-system-validation-and-observability.md`
- `docs/improvements/browser/plan/15-migration-rollout-and-operations.md`
- `docs/improvements/browser/plan/evidence.md`
