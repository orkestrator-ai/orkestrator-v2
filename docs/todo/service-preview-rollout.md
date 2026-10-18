# Service preview rollout

Checked against `main` at `2459b05c` (2026-10-15); real-Electron run against
`a5d338c1` (2026-10-18).

Service previews shipped in #831 (`4f02156b`). Each previewed application gets
a backend-owned service identity, carried by a desktop tunnel, private HTTPS
origins or an optional container relay. Every new transport ships off by
default. Real-stack evidence is single-machine only: Linux and Chromium
(2026-09-23), macOS re-baselines (2026-10-17), and a real Electron window with
the desktop tunnel on (2026-10-18). This file covers four things: the platform runs each
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
  §"Opt-in preview checks". They have no mise task and do not run in CI. All
  of these suites, and every preview unit file, were re-baselined on
  2026-10-17 at `31d0fb06` (see the evidence log).
  `e2e/agent-testing/service-preview-electron.spec.ts` (in
  `mise run test:agent:electron`, so not in CI either) opens two worktree
  services in the real Electron window with `ORKESTRATOR_PREVIEW_TRANSPORT=1`
  on a disposable agent-test profile. Agent-test backends keep that variable
  and `ORKESTRATOR_PREVIEW_RELAY` (`AGENT_TEST_SAFE_ENV_NAMES` in
  `apps/desktop/electron/backend-process.ts`); before 2026-10-18 they were
  stripped, so the override silently did nothing in an isolated profile.

## Outstanding work

### Code

1. A hostile service-worker route in `test-fixtures/preview-app/server.ts`
   that registers a worker intercepting `/__orkestrator_preview/session`. The
   fixture's benign `/sw.js` (2026-10-18) is the starting point.
2. Relay fault tests for an oversized frame (handled in
   `EnvironmentRelay.onData`) and a protocol-version mismatch (the relay
   script exits). Stdin errors, a silent relay and a wrong nonce are already
   covered.
3. Optional: Playwright `firefox` and `webkit` projects in
   `playwright.preview.config.ts`, as early signal only (not Safari or iOS
   evidence). Optional: new mise tasks for the opt-in suites (for example
   `test:preview:docker` and `test:preview:browser`), with `testing-guide.md`
   updated to use them.
4. Partition retention. Electron has to own this, because the backend knows
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
5. Optional: when a legacy URL tab's port maps unambiguously to a current
   service in the same environment and generation, offer "Open as service".
   Keep ambiguous tabs as they are, with "Choose service". Never infer
   ownership from the port alone or from which environment is active.
6. After the support window (see Open questions), remove compatibility mode
   from `ServiceBrowserTab` and retire the legacy route and its rewrite
   helpers, as a separate reviewed change.
7. Reword the comments that cite deleted plan steps or the old evidence log:
   `PREVIEW_LIMITS` (`packages/protocol/src/preview-services.ts`),
   `preview-header-policy.ts`, and in `apps/backend/src/`
   `core/preview-access.ts`, `core/preview-target-resolver.ts`,
   `core/preview-readiness.ts`, `core/preview-docker.test.ts` and
   `preview-bench.test.ts`.
8. Verify whether legacy URL tabs (`BrowserTab`, `attachUrl` in
   `browser-preview-manager.ts`) have the stale-path bug fixed for service
   tabs on 2026-10-18: `attachUrl` loads whenever the attach URL differs from
   the view's current URL, and the renderer re-attaches on every resize and
   scroll, so a re-attach sent before the renderer saw a link, a redirect or
   Back may undo it. Reproduce in the real window (link, then Back, then a
   resize) before changing anything; the fix would mirror `navigationBasis`.
9. Verify why the pane-layout store re-applies an older saved `browserData.url`
   of a tab after a newer local save. On 2026-10-18 a service tab saved `/`
   then `/app/next` and its `serviceRef.path` later returned to `/`.
   `ServiceBrowserTab` now treats an echo of its own earlier save as stale
   (`persistedBases`), but other tab types may follow such echoes. Check
   whether save acknowledgements or layout events are applied out of order in
   `paneLayoutStore.ts`.
10. Name service tabs after their service in the tab strip. Every browser tab
    is "Browser N" (`DraggableTab.tsx`), so two service tabs can only be told
    apart by opening them.

### Qualification

Each run gates a default or an advertisement. Record every run in the evidence
log below.

- Real Electron window. Gates the desktop tunnel default. Run in an isolated
  profile with `ORKESTRATOR_PREVIEW_TRANSPORT=1` through
  `service-preview-electron.spec.ts` (`mise run test:agent:electron`). Passed
  on 2026-10-18 (see the evidence log): no cookie, localStorage, IndexedDB or
  service-worker crossing between two services; credentialed ingress and
  header injection for HTTP, WS and worker-originated fetches; hide and
  reattach and a renderer reload without reloading the page; history, app
  zoom (bounds on the host at 80, 100 and 125 %), DevTools, screenshots and an
  annotation capture after reattach; preview renderer crash and reload; stable
  resource counts over repeated open, hide and close, and release after the
  retirement lease. Still to cover:
  - no crossing between windows on different backends, and a connection
    switch (both need a second backend connection in the spec);
  - clipboard, and overlays hiding a service view (observed with a startup
    dialog on 2026-10-18, not asserted);
  - hide or unmount during HMR, then reattach (needs the Vite fixture);
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
- Hostile service worker (needs code item 1). Bootstrap and re-bootstrap with
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
  after the remaining real-Electron cases and the two-machine run pass and an observation window
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
- Not run: real Electron service preview (the spec did not exist yet), two
  machines, Firefox, Safari and iOS, Docker Desktop on Windows, Auto
  mappings, real private DNS and certificates, a hostile service worker.

2026-10-18, real Electron window with the desktop tunnel on, branch
`qualify-preview-electron-tunnel-c6ca4deaffee` from `main` at `a5d338c1`.

| Item | Version |
| --- | --- |
| Host | macOS 27.0 (26A425, arm64), one machine shared with other live-test worktrees (load average 23 to 56) |
| Bun / Node (mise) | 1.4.3 / 22.23.1 |
| Electron / Playwright | 44.7.0 / 1.64.0 |
| Profile | agent-test `service-preview-smoke` under a `mkdtemp` root, mock keychain, no provider credentials, removed by the spec |
| Services | two `test-fixtures/preview-app` servers (`svc-a`, `svc-b`) on loopback, registered as `worktree` services of a local fixture environment |

- Effective capabilities: `transport` on through `ORKESTRATOR_PREVIEW_TRANSPORT=1`
  (stored setting still off, asserted), relay and publication off. The first
  attempt showed the variable never reached an agent-test backend: it was not
  in `AGENT_TEST_SAFE_ENV_NAMES`. Fixed, with a test in
  `apps/desktop/tests/backend-process.test.ts`; `ORKESTRATOR_PREVIEW_RELAY` is
  kept too.
- Commands: `bunx playwright test --config
  e2e/agent-testing/playwright.electron.config.ts service-preview-electron.spec.ts`
  (bridges rebuilt first), then `mise run test:logged -- --name agent-electron
  -- mise run test:agent:electron`.
- Results: 7 of 7 tests passed in each of 5 consecutive final runs (45 s to
  2.2 min each) and inside the full Electron suite. Before the fixes below,
  the history test failed in about one run in four.
  - Ingress: the view loads `http://127.0.0.1:<ingress>/`, never the fixture
    port, in a `persist:orkestrator-preview-svc-*` partition. The fixture saw
    `Host: localhost:<port>` and no `x-orkestrator-preview-ingress`,
    `Authorization` or Orkestrator cookie. Raw HTTP and WebSocket requests to
    the ingress without the credential, or with a forged one, got 403
    `forbidden`. A legacy (shared-partition) tab pointed at the ingress
    reached nothing.
  - WebSocket: `fixture.v1` was negotiated, hello and echo crossed the tunnel,
    and the upgrade reached the fixture with `Origin: http://localhost:<port>`
    and no ingress header.
  - Isolation: a cookie, localStorage, an IndexedDB database and a service
    worker set in `svc-a` were all absent from `svc-b` (`/sw/marker` 404 there).
    A reload of `svc-a` served through its worker reached the fixture with the
    worker's fetches credentialed by the partition hook.
  - Hide and reattach through the real renderer (two service tabs), and a
    renderer reload: the view was reused and the page never reloaded.
  - History: Back and Forward after an in-page navigation, with a 1.5 s settle
    to catch any bounce. This exposed the stale-path bug (see "A service view
    owns its path" below). It was fixed in main and the renderer, with tests in
    `browser-preview-service.test.ts`, `main-ipc.test.ts` and
    `ServiceBrowserTab.test.tsx`.
  - App zoom 125, 80 and 100 %: the view's bounds equal the preview host rect
    times the host zoom within 1.5 DIP. Then DevTools opened and closed, a
    `capturePage` gave 1059×777 non-empty pixels, and an annotation capture
    recorded `{ kind: "service", serviceId }` and route `/app/next` with no
    ingress URL.
  - `forcefullyCrashRenderer`: the tab showed "Preview renderer stopped", and
    **Reload preview** recovered the page through the tunnel.
  - Resources over 8 open, hide and close cycles: web contents 4 before and
    after, attachments 2 before and after (2 issued over the whole run),
    fixture sockets 3 (pool bound 6). After closing every holder and the
    30-second lease: 0 attachments, 0 fixture sockets, ingress closed.
- Spec fixes during the run: a startup dialog ("Continue Without GitHub CLI")
  hides native views, and `dismissStartupDialogs` runs only before a locator
  action or assertion, never during main-process polls. The visibility polls
  now give it one on every read. The same cause fits flake
  [0272](../tests/flaky-tests/0272-annotation-home-reload-native-view.md); its
  Home test got the same change.
- Full Electron suite on the loaded host: the service-preview spec passed 7/7.
  `electron-main.spec.ts` (two tests) and `terminal-input-resume-electron.spec.ts`
  failed their 5-second window-title checks at launch, and the annotation Home
  test failed as in 0272, all at load average 34 to 56 and again alone. At
  load 12 to 17 the two title specs passed alone with `main`'s product code
  and with this branch's, so the title checks are recorded as flake
  [0470](../tests/flaky-tests/0470-electron-launch-title-timeout-under-load.md).
  With the 0272 change the annotation spec passed 10/10 twice alone. A second
  full run (`ORKESTRATOR_AGENT_TEST_RUN_ID=svc-preview-c6ca-suite2`) had 21
  passed, 1 skipped (the Linux Wayland case) and 0 failed, in 2.7 min.
- Repository checks: `mise run check` passed. The first full `mise run test`
  failed only on a case-file status format in this change (fixed) and the
  known aggregate timeouts
  [0258](../tests/flaky-tests/0258-coordinator-fixture-digest-aggregate-timeout.md)
  and [0178](../tests/flaky-tests/0178-pi-vendor-runtime-aggregate-timeout.md),
  both of which passed alone. The second full run passed (323 s). After
  merging `main` at `68dc1c8d`, `mise run check` passed and the full run
  failed only on flake [0180](../tests/flaky-tests/0180-worktree-tracked-edit-cache-hit.md)
  (passed alone) and on two tests broken on `main` itself by the README
  rewrite (#1077): `tiptap-extensions.test.ts` "accepts the repository
  Markdown files that previously failed" and `tests/unit/install-script.test.ts`
  "is served at the URL both READMEs tell users to pipe into bash". Both fail
  alone against `main`'s README, which this branch does not touch.
- Not run (still listed under Qualification): windows on different backends
  and a connection switch, clipboard, asserted overlays, HMR reattach,
  keyboard and narrow viewport. Noticed but out of scope: dev and agent-test
  profiles report Electron's 44.7.0 to the backend, so a version reminder
  shows (already tracked in
  [test-suite-and-ci-health.md](test-suite-and-ci-health.md)).
- Cleanup: the spec removes its temporary root (profile, fixture repository,
  worktree) and stops Electron, the backend, its Vite group and both
  fixtures. No containers were used. No leftover process or temp root was
  found after an interrupted run.

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
- Tunnel queue overload is backpressure; only admission fails with
  `capacity-exceeded` (2026-10-17). `pumpToClient` checks the queue before
  each frame. At `tunnelQueueMaxBytesPerDirection` it pauses the upstream and
  hands the rest of the read back with `unshift`. That keeps the queue within
  one frame of the limit whatever the runtime's read size (Bun reads 512 KiB,
  Node 64 KiB, and the relay channel delivers whatever arrives). The rejected
  options:
  - Bounding the read size with `highWaterMark`. Bun ignores it for socket
    reads, and it does not apply to relay channels.
  - Keeping a remainder buffer in the tunnel. This adds a second queue, and
    the upstream can emit `end` while the remainder is still held, which
    would put EOF ahead of the data.
  - Raising the hard ceiling. It stays proportional to the read size.
  The old twice-the-limit capacity close has no reachable trigger, so it was
  removed. A reader that stops entirely holds at most the queue, one read and
  its admission slot until the 30-second liveness ping closes it.
- A closing tunnel lets a slow reader drain (2026-10-17). `PreviewWebSocket`
  starts its 2-second close-handshake grace from the close frame's write
  callback, which runs once every earlier byte has been flushed. Before that
  the grace started when the close frame was queued, so a reader more than
  2 seconds behind lost the response tail and saw 1006 instead of EOF.
  `closeDrainTimeoutMs` (default 30 s, the liveness interval) bounds a peer
  that stops reading during the close, and the liveness interval stops once
  the tunnel is closing so an unanswered ping cannot cut the drain short.
  Progress polling on `writableLength`
  was rejected because Node coalesces queued writes into one `writev`, so
  progress shows only when the whole batch completes.
- A service view owns its path (2026-10-18). The renderer learns in-page
  navigation from state events, so a re-attach it sent before it applied one
  carried the previous path, and main reloaded that path: Back, a link or a
  redirect could be undone by a routine bounds sync, and the view could bounce
  between two paths. Each state now carries `service.navigation`, and each
  attach the `navigationBasis` its path was chosen against; main navigates
  only for a path chosen against its latest navigation, and counts a history
  move when it starts, not when it commits. Rejected options:
  - Comparing only against the last path the renderer asked for: a catch-up
    attach for a link's path can be sent before the renderer sees Back, so it
    looks like a new request (seen in the live run).
  - Keeping the renderer's path in a ref and re-reading it on each sync: the
    attach and the state event still cross in flight.
  - Separate navigate and bounds channels: a larger protocol change for the
    same outcome, and older renderers would still need a fallback.
  Cost: a path the user asks for while the page is navigating on its own can
  be dropped, because the page navigated last; the renderer then shows the
  view's path. Older renderers that send no basis keep the
  "only a path not already asked for" rule.
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
- Should tunnel liveness outlast a reader paused by backpressure? The desktop
  stream stops reading the WebSocket while Chromium is not consuming (paused
  media, for example). The backend's ping then waits behind queued data, gets
  no pong, and the tunnel is terminated 30 to 60 seconds later. Options: keep
  this as the stopped-reader bound; add a separate, longer stall deadline that
  resets on drain; or ping on a channel that is not behind application data.

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
