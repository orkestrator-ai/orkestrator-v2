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
  `terminal-input-resume-electron`. All of these suites, and every preview unit
  file, were re-baselined on 2026-10-17 at `31d0fb06` (see the evidence log).

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
4. Pause the tunnel upstream before one read can trip the capacity close.
   `pumpToClient` (`apps/backend/src/preview-tunnel-server.ts`) pauses the
   upstream only after a whole `data` chunk is framed, and Bun reads 512 KiB
   at a time. When the client's kernel buffer is full, the first such read
   closes the tunnel with `capacity-exceeded` instead of pausing it, so a
   reader that is slow but still reading loses the tunnel. Since 2026-10-17
   the queue itself stays within twice the per-direction limit (flake
   [0184](../tests/flaky-tests/0184-preview-tunnel-stopped-reader-queue.md)).
   Bound the upstream read size (for example with the socket's
   `highWaterMark`) or pause per frame, and add a slow-reader test that
   expects a pause rather than a close.
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
  ports, recreation onto a reused port, and the `docker exec` relay. On
  2026-10-17 the opt-in Docker suite passed on Docker Desktop 4.93.0 for macOS
  (binding inspection, a same-port host decoy, recreation onto a reused port
  and the exec relay). That run used Docker-assigned host ports, not
  Orkestrator's Auto mapping (`hostPort: 0`). Windows and Auto mappings are
  still open.
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

2026-09-23, the #831 change set (merged as `4f02156b`). Superseded as the
baseline by the 2026-10-17 run below.

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

2026-10-16, preview header authority follow-up, working tree based on
`6892c000b`, macOS arm64, Bun 1.4.3, Node 24.21.0, Playwright 1.64.0:

- `mise run test:logged -- --name preview-forward -- bun test --cwd
  packages/protocol --preload ../../tests/setup-node.ts
  ./src/node/preview-forward.test.ts --parallel=1 --only-failures`: 30 passed.
- `mise run test:logged -- --name preview-publication -- bun test --cwd
  apps/backend --preload ../../tests/setup-node.ts
  ./src/preview-publication.test.ts --parallel=1 --only-failures`: 12 passed.
  Mapped-Origin HTTP writes and WebSocket upgrades omit `X-Forwarded-Host`
  and preserve the public protocol, including HTTPS publication; default-port
  private origins use a canonical `Host` for the CSRF fallback.
- `mise run test:logged -- --name preview-browser -- bunx playwright test
  --config e2e/preview/playwright.preview.config.ts`: 5 passed, 1 skipped
  (Vite fixture not installed). The authenticated Chromium paths used the
  isolated preview harness and throwaway PKI, with no external opt-in flags.
- A disposable Next.js 16.2.9 app (React 19.3.1) passed two live checks through
  `forwardPreviewRequest`: a multipart form Server Action accepted the mapped
  origin without an allowed-origins override, returned a 303 to an explicitly
  configured public callback URL, and set a Secure cookie based on
  `X-Forwarded-Proto`. API navigation, Origin-bearing GET, and POST requests
  kept the same callback URL and Secure-cookie decision. Local reproduction
  artifact: `output/agent-testing/preview-authority/next-smoke.test.ts`; command:
  `mise run test:logged -- --name preview-next-live -- bun test --cwd
  packages/protocol --preload ../../tests/setup-node.ts
  ./../../output/agent-testing/preview-authority/next-smoke.test.ts --parallel=1`.
  The artifact creates and removes its own temporary app and stops its server.
- Preview harnesses, browser processes, and throwaway PKI were cleaned up. No
  development profile or Docker container was started. Electron, Docker, iOS,
  and two-machine checks were omitted because this change only adjusts shared
  request headers and their tests.
- Format, lint, and typecheck passed. The complete non-iOS command
  `PATH="/opt/homebrew/bin:$PATH" mise run test:logged -- --name full-tests-host-python -- mise run test`
  passed every group and package except the backend's existing
  [0187 Git-excludes timeout](../tests/flaky-tests/0187-workspace-artifact-git-excludes-timeout.md).
  Its unchanged owning file passed alone in 33.0 seconds; the recurrence and
  compressed failure evidence are recorded in that case.

2026-10-17, re-baseline after #966, #967 and #969 on `main` at `31d0fb06`.
This replaces the 2026-09-23 file lists as the current baseline.

| Item | Version |
| --- | --- |
| Host | macOS 27.0 (Darwin 27.0.0, arm64), one machine shared with nine other live-test worktrees (load average 19 to 37) |
| Bun / Node (mise) | 1.4.3 / 22.23.1 |
| Docker | Docker Desktop 4.93.0, engine 29.8.1; image `orkestrator-v2:latest` (`sha256:fa32f2248e1e`, Node 24.21.0 inside) re-tagged `orkestrator-v2:preview-rebaseline-084636` for the run |
| Browser | Chrome for Testing headless shell 156.0.8078.4 (Playwright 1.64.0) |
| Electron | 44.7.0 |
| Vite fixture | 7.3.6, isolated copy at `/tmp/preview-vite-084636` |

- Opt-in variables: `ORKESTRATOR_TEST_DOCKER_PREVIEW_IMAGE` and
  `ORKESTRATOR_TEST_DOCKER_RELAY_IMAGE` (the re-tagged image),
  `ORKESTRATOR_TEST_PREVIEW_VITE_DIR=/tmp/preview-vite-084636`,
  `ORKESTRATOR_PREVIEW_BENCH=1`. Effective capabilities were the defaults
  (`transport`, `relay` and publication off); the suites enable what they test
  on their own harnesses.
- Commands: the three opt-in commands from `testing-guide.md` §"Opt-in preview
  checks" (Docker through `mise run test:logged`, browser and bench through
  `mise exec`), then each owning file below alone with `bun test --cwd <package>
  --preload ../../tests/setup-node.ts <file> --parallel=1` (web and root use
  their own `bunfig.toml` preloads). Bun counts a skipped `describe`'s hooks as
  skips, so the default-gate skip totals below are tests, not Bun's figure.
- Counts, all passing, with default gates (opt-in gates on, where different):

  | Package | File | Tests |
  | --- | --- | --- |
  | protocol | `src/node/preview-forward.test.ts` | 30 |
  | protocol | `src/node/preview-http1.test.ts` | 19 |
  | protocol | `src/node/preview-websocket.test.ts` | 7 |
  | protocol | `src/preview-services.test.ts` | 21 |
  | backend | `src/core/commands-registry-previews.test.ts` | 6 |
  | backend | `src/core/preview-access.test.ts` | 11 |
  | backend | `src/core/preview-docker.test.ts` | 0, 1 skipped (1 on Docker) |
  | backend | `src/core/preview-port-publication.test.ts` | 4 |
  | backend | `src/core/preview-service-registry.test.ts` | 15 |
  | backend | `src/core/preview-target-resolver.test.ts` | 18 |
  | backend | `src/preview-bench.test.ts` | 0, 1 skipped (1 with the bench flag) |
  | backend | `src/preview-publication.test.ts` | 12 |
  | backend | `src/preview-relay-supervisor.test.ts` | 14, 1 skipped (15 on Docker) |
  | backend | `src/preview-tunnel-server.test.ts` | 11 |
  | backend | `src/preview-vite.test.ts` | 0, 2 skipped (2 with the Vite fixture) |
  | backend | `tests/gateway-preview.test.ts` (rollback drill) | 8 |
  | backend | `tests/gateway-proxy.test.ts` (legacy route) | 31 |
  | backend | `src/core/storage-writer-guards.test.ts` (#969 preview stores) | 20 |
  | desktop | 15 `tests/*preview*.test.ts` files | 221 |
  | desktop | `tests/desktop-window-lifecycle.test.ts` (partitions) | 6 |
  | web | `ServiceBrowserTab`, `BrowserTab`, `EnvironmentPreviewServices`, `PreviewSettings` | 75 |
  | web | `browser-address`, `native/browser-preview`, `pane-layout-preview-targets`, `preview-external`, `preview-service-display`, `previewServiceStore` | 34 |
  | root | `tests/unit/protocol-browser-preview.test.ts`, `tests/unit/ios-mobile-contracts.test.ts` | 19 |
  | real Chromium | `e2e/preview/private-origin.spec.ts` | 6 (Vite HMR included) |

  Totals: protocol 77, backend 150 with 5 skipped (155 with every opt-in gate
  on), desktop 227, web 109, root 19, real Chromium 6.
- Docker Desktop for macOS: same-port containers with a host decoy,
  recreation onto a reused port and the `docker exec` relay passed. This is
  the first Docker Desktop evidence; see the Docker Desktop qualification item
  for what remains.
- Loopback latency (`preview-bench.test.ts`, 200 samples after 10 warm-ups):
  direct p50 0.12 / p95 0.20 ms, desktop tunnel 0.25 / 0.33 ms, private
  origin 0.77 / 0.90 ms. Same method as 2026-09-23; a different machine, so
  not comparable.
- `mise run test:agent:electron` did not start cleanly at first.
  `electron-main.spec.ts` (two tests) and the first
  `web-annotations-electron.spec.ts` test timed out waiting for the first
  window. Cause: the specs' fixed profile names give fixed `safeStorage`
  Keychain items (`Orkestrator AI — DEV [electron-smoke] Safe Storage`,
  `… [annotation-smoke] …`), created on 2026-10-01 by an earlier Electron
  build. Electron 44.7.0 is not on their access lists, so
  `ConnectionManager.initialize()` waited on an unanswerable Keychain prompt
  before any window existed. A standalone probe hung for over 20 s with those
  names and returned in milliseconds with `[electron-resume]` (created
  2026-10-15) or a fresh name. Agent-test profiles on macOS now launch with
  Chromium's `use-mock-keychain` (`chromiumSwitchesForRuntime` in
  `apps/desktop/electron/runtime-profile.ts`), which keeps encryption working
  and writes nothing to the login Keychain. After the fix the suite had 10
  passed, 1 skipped (the Linux Wayland case) and 1 failed: `real Electron
  main process shares one backend across independent windows`. That test
  failed in all six runs after the fix, in the suite and alone: four times at
  the native OS-focus assertion and twice earlier at the 5-second window-title
  check. It is recorded as environmental
  ([0271](../tests/flaky-tests/0271-electron-native-focus-shared-macos-desktop.md)).
  Flake [0157](../tests/flaky-tests/0157-electron-first-window-startup-timeout.md)
  has the same symptom; the Keychain cause is recorded there.
- Flakes: [0184](../tests/flaky-tests/0184-preview-tunnel-stopped-reader-queue.md)
  was a real bound overrun (the capacity check ran once per 512 KiB upstream
  read, not per frame) and is fixed in the tunnel server;
  [0195](../tests/flaky-tests/0195-preview-handoff-container-reconciliation.md)
  and [0221](../tests/flaky-tests/0221-preview-first-chunk-timing.md) were
  test ordering and timing problems and are fixed in their tests. Before and
  after stress counts are in each case file.
- Cleanup: no containers from the re-tagged image remained. The two
  `test:agent:electron` specs that timed out leaked their Vite dev servers
  (detached process groups whose `finally` never ran); they were stopped by
  hand, and the leak is tracked in
  [test-suite-and-ci-health.md](test-suite-and-ci-health.md). Throwaway PKI and
  preview harness directories were removed by the suites. The Keychain item
  created by the probe was deleted.
- Not run: real Electron service preview (code item 1 does not exist yet), two
  machines, Firefox, Safari and iOS, Docker Desktop on Windows, Auto
  mappings, real private DNS and certificates, a hostile service worker.

## Constraints and rationale

- The threat boundaries, the credential and data path, and the resource-owner
  table are in
  [browser-previews.md](../architecture/browser-previews.md) §"Security
  boundaries". Every change must keep them. In short: application code is untrusted
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

## Replaces

- `docs/improvements/browser/README.md` (findings status, leftovers)
- `docs/improvements/browser/current-state.md` (legacy-route limitations)
- `docs/improvements/browser/proposal.md` §2 (rejected transports), §3
  (storage retention)
- `docs/improvements/browser/validation.md` (acceptance matrix)
- `docs/improvements/browser/plan/00-index.md` (decisions, invariants)
- `docs/improvements/browser/plan/01-decision-record.md` (prototype blockers;
  threat boundaries, data path and resource ownership moved to
  `architecture/browser-previews.md`)
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
