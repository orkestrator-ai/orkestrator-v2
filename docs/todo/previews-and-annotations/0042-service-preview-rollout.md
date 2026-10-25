# Service preview rollout

Checked against `main` at `2459b05c` (2026-10-15); real-Electron runs against
`a5d338c1` (2026-10-18) and `9b3f53a2` (2026-10-21); partition retention,
fault tests and single-machine runs against `b83ae534` (2026-10-22); node
retention, tunnel liveness, compatibility cases and UI items against
`00a0cb82` (2026-10-25).

Service previews shipped in #831 (`4f02156b`). Each previewed application gets
a backend-owned service identity, carried by a desktop tunnel, private HTTPS
origins or an optional container relay. Every new transport ships off by
default. Real-stack evidence is single-machine only: Linux and Chromium
(2026-09-23), macOS re-baselines (2026-10-17), and a real Electron window with
the desktop tunnel on (2026-10-18, remaining cases 2026-10-21), and a
hostile service worker in Chromium and Auto mappings on Docker Desktop for
macOS (2026-10-22). This file covers four things: the platform runs each
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
  (`persist:orkestrator-preview-svc-<slot>-<connection>-<hash>`).
  `PreviewTransportManager.resetSiteData` clears one on request. Since
  2026-10-22 `PreviewPartitionRetention`
  (`apps/desktop/electron/preview-partition-retention.ts`) clears a service's
  partition once its service is gone from the backend's full list (removed, or
  its environment deleted), and every preview partition of a forgotten
  connection, then removes the directories on the next start; see
  [browser-previews.md](../../architecture/browser-previews.md). Since
  2026-10-25 it also clears a workspace node's partitions once every command
  node that listed the node has removed it. The shared legacy partitions of
  live connections are never cleared. A legacy URL tab is converted to a
  service tab only when the user chooses **Open as service** (2026-10-25).
- Tests: `e2e/preview/private-origin.spec.ts` has Chromium, Firefox and WebKit
  projects on an isolated stack (`apps/backend/src/preview-browser-harness.ts`,
  throwaway CA and browser-local loopback proxy). Since 2026-10-25, each runs
  14 cases plus opt-in Vite HMR, including sibling reads, hostile workers,
  external redirects into same-service frames, `srcset`, source maps, SPA
  deep links, storage isolation, frame and popup handling and an IPv6-only
  target. WebKit is engine signal,
  not shipping Safari/iOS qualification. The opt-in Docker, relay, Vite and
  benchmark suites are listed in [`testing-guide.md`](../../development/testing-guide.md)
  §"Opt-in preview checks"; since 2026-10-22 they are `mise run
  test:preview:docker`, `test:preview:browser` and `test:preview:bench`. None
  runs in `mise run test` or CI. All
  of these suites, and every preview unit file, were re-baselined on
  2026-10-17 at `31d0fb06` (see the evidence log).
  `e2e/agent-testing/service-preview-electron.spec.ts` (in
  `mise run test:agent:electron`, so not in CI either) opens worktree
  services in the real Electron window with `ORKESTRATOR_PREVIEW_TRANSPORT=1`
  on a disposable agent-test profile: 17 tests since 2026-10-25, including a
  Vite application, a second window on a second, disposable standalone
  backend, a retention pass, Reset site data with a hostile worker and legacy
  URL tab history. Agent-test backends keep that variable
  and `ORKESTRATOR_PREVIEW_RELAY` (`AGENT_TEST_SAFE_ENV_NAMES` in
  `apps/desktop/electron/backend-process.ts`); before 2026-10-18 they were
  stripped, so the override silently did nothing in an isolated profile.

## Outstanding work

### Code

1. Done 2026-10-22: the hostile service-worker route (see the evidence log).
2. Done 2026-10-22: relay fault tests for an oversized frame and a
   protocol-version mismatch, which found and fixed an unbounded stdout buffer
   after a relay shut down (see the evidence log).
3. Done 2026-10-23: Playwright `firefox` and `webkit` projects in
   `playwright.preview.config.ts`, as early signal only (not Safari or iOS
   evidence). See the cross-service read follow-up in the evidence log.
4. Partition retention. Removed services, deleted environments and forgotten
   connections are done (2026-10-22, `PreviewPartitionRetention`). It diffs
   against the full, unfiltered definition list rather than tombstones:
   tombstones live only in memory, so every backend restart (new epoch) would
   need the full diff anyway, and the list is bounded
   (`snapshotMaxBytes`). Remaining:
   - Once legacy URL tabs are retired, set a retention window for the shared
     window/connection partitions of live connections, then clean up only
     partitions this install created.
   - Done 2026-10-25: partitions keyed to a workspace node (`node:<id>`) are
     cleared once every command node that listed the node has removed it
     (`rememberNode`, `reconcileNodes`, `transferNodes` in
     `preview-partition-retention.ts`, wired in `main.ts`). Ten unit tests in
     `apps/desktop/tests/preview-partition-retention.test.ts` ("node
     partitions"). Not exercised against a real command node with a forgotten
     node; see the evidence log.
   - Done 2026-10-25: a service-removal pass ran in a real Electron window.
     Agent-test profiles may shorten the passes with
     `ORKESTRATOR_AGENT_TEST_PREVIEW_RETENTION_MS` (100 ms to 30 min,
     `previewRetentionTimingForRuntime` in `runtime-profile.ts`; every other
     flavor ignores it, unit-tested). The spec removes a service whose tab it
     closed and sees its partition's cookies cleared 31 to 32 s later (the
     30 s retirement lease plus one pass), the partition listed in
     `preview-partitions-pending.json`, the sibling's cookie kept, and after a
     relaunch the directory gone and the sibling's directory and cookie kept.
5. Done 2026-10-25: a legacy URL tab whose loopback port maps to exactly one
   enabled, available service of its own environment in the current backend
   epoch shows **Open as service** (`legacyUrlServiceMatch`,
   `confirmLegacyUrlServiceMatch` in `apps/web/src/lib/preview-service-entry.ts`,
   `BrowserTab.tsx`). The click re-reads the snapshot and converts only if the
   same service still has the same epoch and endpoint generation, keeping the
   path, query and fragment. Ambiguous tabs are left as they are with no
   prompt (legacy URL tabs never had a "Choose service" flow; that exists only
   for terminal links). Tests: `preview-service-entry.test.ts` (new) and
   `BrowserTab.test.tsx`.
6. After the support window (see Open questions), remove compatibility mode
   from `ServiceBrowserTab` and retire the legacy route and its rewrite
   helpers, as a separate reviewed change.
7. Done 2026-10-22: comments citing deleted plan steps reworded (the listed
   files and `apps/web/src/vite-env.d.ts`).
8. Done 2026-10-25: the bug reproduced in the real window. Back during a
   resize burst left a legacy URL tab bouncing between `/` and `/app/next`
   12 times, and a re-attach sent right behind Back also bounced. Fixed as for
   service tabs: URL states carry `navigation`, the renderer sends each URL's
   `navigationBasis` (`BrowserTab.tsx`, `ipc.ts`,
   `packages/protocol/src/browser-preview.ts`), and `attachUrl` loads only a
   URL chosen against the view's latest navigation; renderers that send no
   basis keep the old rule. Unit tests in `browser-preview-manager.test.ts`,
   `main-ipc.test.ts` and `BrowserTab.test.tsx` fail without their half of
   the fix. After it, 5 of 5 UI rounds and both deterministic cases (Back and
   a link) held in the real window; the spec keeps them as a regression
   case.
9. Verified 2026-10-25: the store does not apply saves out of order. Local
   saves are queued per environment (`pane-layout-persistence.ts`), an older
   save's acknowledgement is skipped after a newer local edit, change-feed
   reads are declined while a local write is queued or in flight or when
   their revision is older, and a declined read is re-fetched after the local
   writes (`store-resource-sync.ts`, only the newest read applies). A
   regression test (`store-resource-sync.test.ts`: a plain URL tab saves `/a`
   then `/b`, and the `/a` read answers late) fails with those guards removed.
   The 2026-10-18 return to `/` fits the re-attach bug in item 8 instead.
   Another client's `save_pane_layout` is meant to reach an open renderer
   (change announcement, re-read, adopt), and new tests show it does in both
   a browser client and an Electron-style window. Re-selecting an environment
   never re-reads the layout (hydration is once per renderer), so it could not
   have recovered a missed update. Still open: the 2026-10-21 miss did not
   reproduce at unit level; check in a real Electron window whether that
   announcement reaches it.
10. Done 2026-10-22: service tabs are named "<service label> N" once their
    environment's service list is loaded (`DraggableTab.tsx`); other browser
    tabs stay "Browser N". The Electron spec now finds service tabs by that
    name.
11. Done 2026-10-25: the toolbar now stays on one row only from
    `@2xl/browser` (672 px); below that the address takes a full-width second
    row, and on one row it keeps at least `min(10rem, 60%)` while the service
    picker shrinks first (shared classes in `browser-tab-hooks.ts`, used by
    `ServiceBrowserTab.tsx` and `BrowserTab.tsx`). Worked out from the classes,
    a 519 px pane gives the address about 358 px in a service tab and 371 px in
    a URL tab (was 92 and about 144). Class-contract tests only; not measured
    in a real window.
12. Done 2026-10-25: flake
    [0620](../../tests/flaky-tests/previews-annotations-and-gateway/0620-service-preview-keyboard-picker-register-item.md)
    (the keyboard test missing **Register a service…** under Chromium timer
    throttling) held on loaded runs: it passed in all 7 runs (5 single-spec,
    2 full suites, load 21 to 80). The three throttling switches moved into
    `ELECTRON_TEST_SWITCHES` (`electron-launch-switches.ts`), so every
    Electron spec gets them. 0620 stays open in the registry for one more
    loaded window.
13. Flake [0622](../../tests/flaky-tests/previews-annotations-and-gateway/0622-service-preview-window-close-remote-release.md):
    once, in a slow run, a remote preview attachment was still held 20 s after
    its window's `close()`. It did not recur; the spec now times the close
    and the release separately. If it recurs with the window gone, capture
    Electron's output and check the close-path release. 2026-10-25: no
    recurrence in 6 runs on this branch (window gone 208 to 230 ms after
    `close()`), but the registry records a recurrence the same day on another
    branch at an earlier attachment-count check, with no output captured.
    Still open.

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
  retirement lease. The remaining cases passed on 2026-10-21, after fixes:
  windows on different backends and connection switches (use, connect, and
  window close), clipboard, overlays, HMR reattach, and keyboard and narrow
  viewport use of the picker, service dialog and diagnostics. Single machine
  only; the two-machine run below is still needed for remote backends over a
  real network.
- Two-machine tailnet. Gates remote desktop previews by default. The runbook
  is [preview-two-machine-runbook.md](../../development/preview-two-machine-runbook.md)
  and the latency tool `scripts/preview-latency-baseline.ts` (2026-10-22,
  self-tested on loopback only). Not run. Cover:
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
- Firefox, Safari and iOS, top-level. Firefox passed bootstrap, sibling
  isolation, the `fixture.v1` subprotocol, revocation and hostile-worker
  checks on 2026-10-23 (throwaway certificate bypass; deployment trust remains
  open). WebKit passed the same engine checks. Shipping Safari remains open;
  cover those cases there with real certificate trust. Run the iOS
  handoff (`create_preview_handoff_url`, contract-tested only in
  `tests/unit/ios-mobile-contracts.test.ts`) on a device or simulator:
  opening in Safari, background and foreground, and private browsing.
  Embedded surfaces are in [0046-embedded-service-previews.md](0046-embedded-service-previews.md).
- Docker Desktop on macOS and Windows: resolver binding inspection, Auto host
  ports, recreation onto a reused port, and the `docker exec` relay. On
  2026-10-17 the opt-in Docker suite passed on Docker Desktop 4.93.0 for macOS
  (binding inspection, a same-port host decoy, recreation onto a reused port
  and the exec relay). That run used Docker-assigned host ports, not
  Orkestrator's Auto mapping (`hostPort: 0`). On 2026-10-22 an Auto mapping
  passed on Docker Desktop 4.88.1 for macOS (published with the backend's own
  `publishedPortArguments`, seeded, resolved from Docker's binding and
  followed through recreation). Windows is still open.
- Hostile service worker. Real Chromium on private origins passed on
  2026-10-22 (see the evidence log): re-sign-in is blocked until site data is
  cleared, the worker never sees a grant, its captured session code is
  refused by other hosts, and no control authority is reached. It did reach a
  sibling service with a credentialed read, which contradicted "no other
  service is ever reached"; since 2026-10-23 the backend refuses that read
  and the spec asserts nothing reaches the sibling
  ([0054-preview-cross-service-reads.md](0054-preview-cross-service-reads.md)).
  The same worker checks passed in Firefox and Playwright WebKit on
  2026-10-23. Electron's **Reset site data** with the hostile and benign
  workers installed on a desktop-tunnel service passed on 2026-10-25 (see the
  evidence log). Still open: shipping Safari.
- Compatibility cases. Passed in Playwright Chromium, Firefox and WebKit on
  2026-10-25 (see the evidence log): SPA deep links and history, the `srcset`
  route, source maps, IndexedDB, BroadcastChannel, service-worker and Cache
  isolation between siblings, frame denial of bootstrap, session and refusal
  pages and the web client's no-opener popup, and an IPv6-only (`::1`)
  target. Still not run in a real browser:
  - a streaming or router framework fixture alongside the pinned Vite 7.3.6;
  - real-provider OAuth compatibility (synthetic external redirects into a
    same-service frame and top-level return are covered since 2026-10-23).
- Performance thresholds. Set them from the two-machine baseline (first byte,
  connect time, HMR delivery, peak queue and decode bytes, socket counts)
  before any cohort counts as passing. Not set: no two-machine baseline
  exists. `PreviewMetrics` (`apps/backend/src/preview-metrics.ts`) has
  `http.connect_ms`, `http.first_byte_ms` (declared but never recorded until
  2026-10-22; now recorded per private-origin request) and `tunnel.open_ms`
  histograms, but nothing for HMR delivery or reconnects, and nothing for the
  desktop ingress, which lives in Electron. `scripts/preview-latency-baseline.ts`
  measures connect and first byte per route from the client side.

### Enabling defaults

- Desktop tunnel: change `DEFAULT_PREVIEW_SETTINGS.transport` to `true` only
  after the two-machine run passes and an observation window with error and
  resource thresholds is recorded here. The real-Electron cases passed on
  2026-10-21. An absence of
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
  [0187 Git-excludes timeout](../../tests/flaky-tests/environments-and-containers/0187-workspace-artifact-git-excludes-timeout.md).
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
  ([0271](../../tests/flaky-tests/electron-and-desktop/0271-electron-native-focus-shared-macos-desktop.md)).
  Flake [0157](../../tests/flaky-tests/electron-and-desktop/0157-electron-first-window-startup-timeout.md)
  has the same symptom; the Keychain cause is recorded there.
- Flakes: [0184](../../tests/flaky-tests/previews-annotations-and-gateway/0184-preview-tunnel-stopped-reader-queue.md)
  was a real bound overrun (the capacity check ran once per 512 KiB upstream
  read, not per frame) and is fixed in the tunnel server;
  [0195](../../tests/flaky-tests/previews-annotations-and-gateway/0195-preview-handoff-container-reconciliation.md)
  and [0221](../../tests/flaky-tests/previews-annotations-and-gateway/0221-preview-first-chunk-timing.md) were
  test ordering and timing problems and are fixed in their tests. Before and
  after stress counts are in each case file.
- Cleanup: no containers from the re-tagged image remained. The two
  `test:agent:electron` specs that timed out leaked their Vite dev servers
  (detached process groups whose `finally` never ran); they were stopped by
  hand, and the leak is tracked in
  [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md). Throwaway PKI and
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
  [0272](../../tests/flaky-tests/previews-annotations-and-gateway/0272-annotation-home-reload-native-view.md); its
  Home test got the same change.
- Full Electron suite on the loaded host: the service-preview spec passed 7/7.
  `electron-main.spec.ts` (two tests) and `terminal-input-resume-electron.spec.ts`
  failed their 5-second window-title checks at launch, and the annotation Home
  test failed as in 0272, all at load average 34 to 56 and again alone. At
  load 12 to 17 the two title specs passed alone with `main`'s product code
  and with this branch's, so the title checks are recorded as flake
  [0470](../../tests/flaky-tests/electron-and-desktop/0470-electron-launch-title-timeout-under-load.md).
  With the 0272 change the annotation spec passed 10/10 twice alone. A second
  full run (`ORKESTRATOR_AGENT_TEST_RUN_ID=svc-preview-c6ca-suite2`) had 21
  passed, 1 skipped (the Linux Wayland case) and 0 failed, in 2.7 min.
- Repository checks: `mise run check` passed. The first full `mise run test`
  failed only on a case-file status format in this change (fixed) and the
  known aggregate timeouts
  [0258](../../tests/flaky-tests/coordinator-and-multi-review/0258-coordinator-fixture-digest-aggregate-timeout.md)
  and [0178](../../tests/flaky-tests/agent-bridges/0178-pi-vendor-runtime-aggregate-timeout.md),
  both of which passed alone. The second full run passed (323 s). After
  merging `main` at `68dc1c8d`, `mise run check` passed and the full run
  failed only on flake [0180](../../tests/flaky-tests/environments-and-containers/0180-worktree-tracked-edit-cache-hit.md)
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
  [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md)).
- Cleanup: the spec removes its temporary root (profile, fixture repository,
  worktree) and stops Electron, the backend, its Vite group and both
  fixtures. No containers were used. No leftover process or temp root was
  found after an interrupted run.

2026-10-21, remaining real-Electron cases, branch
`qualify-preview-electron-remaining-cases-0a835a98d18e` from `main` at
`9b3f53a2`.

| Item | Version |
| --- | --- |
| Host | macOS 27.0 (Darwin 27.0.0, arm64), one machine shared with other live-test worktrees (load average 4 to 31) |
| Bun / Node (mise) | 1.4.3 / 22.23.1 (Bun 1.4.2 on `PATH` for the direct `bunx` and `bun test` runs) |
| Electron / Playwright | 44.7.0 / 1.64.0 |
| Vite application | the checked-in `test-fixtures/preview-vite` sources with the repository's Vite 8.3.4 (`ORKESTRATOR_TEST_PREVIEW_VITE_DIR` unset; set, the spec uses that pinned 7.3.6 install) |
| Profiles | agent-test `service-preview-smoke` (Electron) and `service-preview-remote` (a standalone backend through `BackendProcess`, gateway on loopback), both under one `mkdtemp` root, mock keychain, no provider credentials, removed by the spec |

- Effective capabilities: `transport` on through `ORKESTRATOR_PREVIEW_TRANSPORT=1`
  on both backends; relay and publication off. The second backend's token is
  its own disposable `gateway-auth.json` token, read by the spec and never
  logged.
- Commands: bridges rebuilt, then `bunx playwright test --config
  e2e/agent-testing/playwright.electron.config.ts service-preview-electron.spec.ts`
  (with `--grep` while iterating), then the full Electron suite (below).
- Defects the run exposed, each fixed with unit tests that fail without the
  fix:
  - A connection switch released preview attachments on the wrong backend
    and window close released none; `connect` and `forget` left the old
    previews in place (see "A window's previews belong to their connection").
    Live before the fix: after `connect`, window 2's Local view stayed (1
    view, expected 0), its released tab still held a Local attachment after
    the 30-second lease (2, expected 1), and the second backend's service
    opened in a partition keyed to the Local connection. Tests:
    `apps/desktop/tests/preview-connection-backend.test.ts` (new),
    `connection-manager.test.ts`.
  - Cmd/Ctrl+L did nothing in service tabs, from the app or from inside the
    view (only plain URL tabs listened). The shortcut is now one hook,
    `useAddressBarShortcut` (`browser-tab-hooks.ts`), used by both tab types.
  - **Route details** dropped keyboard focus to the body when it expanded or
    collapsed (the toggle is replaced by another element). It now keeps focus
    on the visible toggle.
  - Closing the service dialog, opened from the picker or **Preview options**,
    dropped focus to the body (its menu item was gone). Focus now returns to
    the menu trigger.
  Tests: `ServiceBrowserTab.test.tsx` (two new) and `PreviewDiagnostics.test.tsx`
  (new).
- Results, by case (all from the real window):
  - Clipboard: a selection copied with the Edit menu's copy role reached the
    host clipboard ("svc-a"); host text pasted into a field in the page.
    `navigator.clipboard.readText()` was denied (`NotAllowedError`), and so was
    a write from a script "gesture"; a write right after a real click in the
    visible view succeeded. On macOS AppKit sends the menu roles to the OS
    first responder, so the spec checks the menu has the role and runs the
    web-contents method the role performs. The host clipboard was snapshotted
    in main and restored.
  - Overlays: the service picker menu, **Preview options**, the register
    service dialog and the project search (Cmd+K) each hid the view while
    open, and it came back on Escape; the page was never reloaded.
  - Keyboard: the picker opens with Enter, moves with arrows, chooses with
    Enter (retargeting the tab to `svc-b` and back), and Escape returns focus
    to its trigger. In the service dialog, 10 Tab and 4 Shift+Tab presses
    never left it, Escape closed it without registering anything, and focus
    returned to the picker. **Route details** expands and collapses with Enter
    and Space and keeps focus, with the view on its shorter host. Cmd+L from
    the app and from inside the view focuses and selects the address.
  - Narrow viewport: the window at its 800×600 minimum, at 100 and 150 % app
    zoom (CSS viewports 800×600 and 533×400). The picker trigger, address,
    picker menu, **Edit service** dialog and its Cancel button lay inside the
    viewport; the view sat on its host within 1.5 DIP and inside the window,
    also with diagnostics expanded. The address field is 92 CSS px wide there
    (code item 11).
  - HMR: a Vite service tab hidden behind another tab, then unmounted (no
    environment selected), then through a renderer reload while an update
    was in flight. Each `label.js` write was applied in place (text updated,
    accept handler ran, same document) and shown on reattach. Both
    `vite-hmr` upgrades Vite saw carried `Host: localhost:<vite port>` and no
    ingress header, so none used Vite's direct fallback socket. One write can
    raise two updates, so the spec checks the count grows.
  - Different backends and switches: window 1 on Local and window 2 on the
    second backend used `persist:orkestrator-preview-svc-1-<local>-…` and
    `…-svc-2-<remote connection>-…`; cookies and localStorage set in each
    service were absent from the other. Window 1 asking for the second
    backend's service was refused (`not-found`) and the remote fixture saw no
    request. Switching window 2 to Local closed its remote view and ingress
    and released the remote attachment at once (0 on the second backend);
    switching back reused the partition (its localStorage was there); closing
    window 2 released it again. Window 1's page was untouched throughout.
- Spec runs once the test-side fixes below were in: 13/13 in 11 of 14 full
  runs, then the first full Electron suite failed the same keyboard test once
  more: flake [0620](../../tests/flaky-tests/previews-annotations-and-gateway/0620-service-preview-keyboard-picker-register-item.md),
  stale focus reads under Chromium's timer throttling. After the spec waited
  for focus and turned the throttling off: 5 of 5 runs passed (55.7 s to
  1.0 min, load 11 to 17), and the second full suite passed. Earlier failures while writing the spec were
  test-side and are fixed in it: a pointer parked over the menu, the
  duplicated HMR update, a hidden `role="dialog"` popover that is always in
  the DOM, and the renderer keeping its hydrated tab set (code item 9).
- Later single-spec runs: one failure, flake [0622](../../tests/flaky-tests/previews-annotations-and-gateway/0622-service-preview-window-close-remote-release.md)
  (a slow run in which window close did not release on the second backend
  within 20 s); then 4 of 4 passed with the close and release timed apart
  (window gone 209 to 217 ms after `close()`).
- Full Electron suite, `ORKESTRATOR_AGENT_TEST_RUN_ID=svc-preview-0a835-suite2
  mise run test:logged -- --name agent-electron-0a835-2 -- mise run
  test:agent:electron`: 28 passed, 1 skipped (the Linux Wayland case), 0
  failed, 175.3 s. The first suite run (`svc-preview-0a835-suite`), before
  the 0620 change: 24 passed, 1 failed (0620), 1 skipped, 3 did not run.
- Repository checks: `mise run check` passed. The first full `mise run test`
  (`full-tests-0a835`) failed on two things in this change, both fixed: a
  source-text assertion in `tests/unit/release/package-config.test.ts` on the
  old `useConnection` code, and two new web assertions that passed a DOM
  query result to `toBeNull` (`tests/unit/test-diagnostic-bounds.test.ts`).
  It also hit backend flakes [0239](../../tests/flaky-tests/backend-services-and-tooling/0239-agent-account-duplicate-directory-cleanup.md)
  and [0341](../../tests/flaky-tests/backend-services-and-tooling/0341-public-exec-restart-cleanup-eperm.md)
  (recurrences) and new [0621](../../tests/flaky-tests/environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md);
  each owning file passed alone at load 36. The second full run
  (`full-tests-0a835-2`) passed in 495.3 s.
- Cleanup: the spec stops Electron, both backends, the renderer Vite group,
  the Vite application group and all three fixtures, and removes its
  temporary root; no process or temporary root was left after the runs. No
  containers were used.

- Review follow-up (2026-10-21, same worktree): release failures now emit the
  static diagnostic `[Previews] Failed to release preview attachment.`; the
  obsolete scope-relative tunnel URL method is removed. A focused transport
  test proves the unavailable-connection path warns once while closing ingress.
  Hook tests cover sibling chat listboxes, two preview consumers, closing but
  still visible overlays, exit-motion completion, and hidden ancestors.
- `ORKESTRATOR_AGENT_TEST_RUN_ID=preview-review-fixes mise run test:logged --
  --name review-electron -- mise run test:agent:electron`: 29 passed, 1 skipped
  (Linux Wayland on macOS), 0 failures, 144.1 s. Added scenarios force capability
  setup to fail after the second backend starts (process exited and gateway
  closed before profile cleanup), and forget its active connection (remote
  view, ingress, sockets and attachment released; the next Local preview uses
  its Local partition; the other window's page remains intact).
- Focused desktop and overlay tests, `format:check`, `lint`, and `typecheck`
  passed through `test:logged`; modified files also have no lint findings.
  `mise run test:logged -- --name review-full-tests -- mise run test` passed
  all four non-iOS groups in 441.3 s. No additional Docker, CLI scenario, iOS,
  or browser component suite was selected: their runtime code was unchanged;
  the real Electron suite exercises the affected desktop paths.
  Electron cleanup removed the disposable service-preview profile root after
  stopping its processes. No production profile or containers were used.

2026-10-22, partition retention, fault tests and single-machine runs, branch
`todo-0042-service-preview-rollout-a6b636a9b237` from `main` at `b83ae534`.
Single machine; nothing here is two-machine, Firefox, Safari, iOS or Windows
evidence.

| Item | Version |
| --- | --- |
| Host | macOS 26.6.2 (arm64), one machine shared with other live worktrees (load average 15 to 458 during the runs) |
| Bun / Node (mise) | 1.4.3 / 24.21.0 |
| Docker | Docker Desktop 4.88.1, engine 29.7.2; `orkestrator-v2:latest` (`sha256:262fff6c6d0c`, Node 24.21.0 inside) re-tagged `orkestrator-v2:preview-0042-034418` for the run, tag removed after |
| Browser | Chrome for Testing headless shell 156.0.8078.4 (Playwright 1.64.0) |

- Effective capabilities were the defaults (`transport`, `relay` and
  publication off); each suite enables what it tests on its own harness. No
  defaults were changed and the legacy route was not touched.
- Relay faults (`preview-relay-supervisor.test.ts`, no Docker needed): an
  oversized frame is refused on its 9-byte header, split or not, and closes
  the relay (frame at the limit still delivered; channel error
  "malformed frame", no content in the error or logs; relay killed and
  released; a new relay after the backoff); an oversized frame in place of
  the ready reply rejects the connect. The relay script exits 3 on an
  unsupported version (2, 0, `"1"`, `null`) without writing to stdout or
  printing the nonce, and 4 on an oversized frame header; a supervisor
  running a script that only accepts version 2 fails the connect at once
  with `backend-unavailable` (not the hello timeout) and does not respawn
  inside the backoff. The run found a real gap: after shutdown
  `EnvironmentRelay` kept its stdout listener and appended whatever the relay
  still wrote to an unbounded buffer. Fixed in `preview-relay-supervisor.ts`
  (listener removed, output drained and discarded); two assertions failed
  without the fix. 23 passed, 1 skipped (Docker) in each of 5 runs.
- Docker Desktop for macOS, `ORKESTRATOR_TEST_DOCKER_PREVIEW_IMAGE=orkestrator-v2:preview-0042-034418
  mise run test:preview:docker`: 26 passed, 0 skipped, in each of 3 runs.
  New journey: an Auto mapping (`hostPort: 0`, `hostPortMode: "auto"`)
  published with the backend's own `publishedPortArguments`, seeded as a
  generated service, resolved from Docker's binding (equal to `docker port`,
  never the container port where a host decoy listened), and followed
  through recreation onto a new Auto port with an impostor on the old one. No
  containers were left behind.
- Hostile service worker, real Chromium on private origins
  (`e2e/preview/private-origin.spec.ts`, "a hostile service worker blocks
  re-sign-in until site data is cleared and reaches no other authority";
  fixture routes `/sw-hostile/install` and `/sw-hostile.js`). The harness now
  also runs a real `OrkestratorGateway` on a throwaway token behind a request
  recorder. Observed:
  - Re-bootstrap with a new grant while the worker is installed: the worker
    answers `/__orkestrator_preview/session?code=…` itself, the browser keeps
    its old session cookie and the new attachment gets none. The worker sees
    the one-use session code, never the grant, and every response it gets is
    opaque or a failed fetch.
  - The captured code presented at the sibling's or the bootstrap host's
    session path is refused (and used up). Kept and redeemed once from a
    clean browser context, it yields a session for the same service only.
  - Control authority: the gateway saw the worker's requests without its
    `SameSite=Strict` cookie or any Authorization header and answered 401
    (GET), 403 "Origin not allowed" (POST) and 403 (preflight); it ran no
    command.
  - Sibling service: the credentialed POST and the CORS bearer request were
    refused before forwarding, but a credentialed `no-cors` `GET /echo`
    reached the sibling application (same-site hosts, `SameSite=Lax` cookie,
    reads not checked). Recorded as
    [0054-preview-cross-service-reads.md](0054-preview-cross-service-reads.md);
    the spec asserts the observed read.
  - After `Storage.clearDataForOrigin` for the app origin only: no worker,
    no app cookies, the sibling's cookie intact, and a fresh bootstrap signs
    in normally.
  `mise run test:logged -- --name preview-browser-hostile-sw -- bunx
  playwright test --config e2e/preview/playwright.preview.config.ts`: 6
  passed, 1 skipped (Vite HMR: `ORKESTRATOR_TEST_PREVIEW_VITE_DIR` unset), 3
  runs; the new test 5 of 5 with `--repeat-each=5`. Harness directories and
  throwaway PKI were removed.
- Loopback bench, `mise run test:preview:bench` (200 samples after 10
  warm-ups, as before): direct p50 0.24 / p95 0.40 ms, desktop tunnel 0.94 /
  1.43 ms, private origin 1.91 / 2.65 ms at load about 37; a later run at
  load about 27: 0.35 / 2.64, 1.18 / 7.43, 2.12 / 7.46. Not comparable with
  other machines.
- Two-machine tool, loopback self-test only
  (`scripts/preview-latency-baseline.ts` against
  `apps/backend/src/preview-baseline-harness.ts`, 200 samples after 10
  warm-ups, `GET /health`, first byte p50 / p95 / max in ms): direct 0.24 /
  0.64 / 1.3, legacy 0.65 / 3.41 / 8.92, desktop tunnel 1.05 / 2.42 / 3.71,
  private origin 2.04 / 6.35 / 20.14, 0 failures; attachments back to 0 after
  release. Its userspace throttle (20 ms one way, 512 KiB/s) and a slow reader
  on `/endless` at 64 KiB/s kept `tunnel.queued_bytes` at 262,176 (the 256 KiB
  limit plus one header). This is the first legacy-route number, on loopback.
- `http.first_byte_ms` was declared but never recorded. `forwardPreviewRequest`
  now reports the time from upstream connect to the response head, and
  `PreviewHttpProxy` records it (`preview-forward.test.ts`,
  `preview-publication.test.ts`).
- Partition retention and service tab names: unit tests only
  (`apps/desktop/tests/preview-partition-retention.test.ts`, 13 tests, one on
  real directories; a retention case in `preview-transport-manager.test.ts`;
  `DraggableTab.test.tsx`). Desktop preview unit files with
  `connection-manager.test.ts` and `desktop-window-lifecycle.test.ts`: 291
  passed (a first run at load about 458 had 2 tests time out at 5 s; the
  rerun passed all).
- Real Electron, `bunx playwright test --config
  e2e/agent-testing/playwright.electron.config.ts service-preview-electron.spec.ts`
  (bridges as built; `ORKESTRATOR_PREVIEW_TRANSPORT=1` on a disposable
  agent-test profile, as before). The first run failed one test: the spec
  found service tabs by "Browser N", which the new service tab names
  replaced. With the spec finding tabs by service name ("svc-a 1",
  "svc-b 2", "preview-vite …"): 14 passed in each of 2 runs (68.1 s and
  58.7 s, load 24 to 45). The full `mise run test:agent:electron` suite was not
  run.
- Repository checks: `mise run format:check`, `mise run lint`, `mise run
  typecheck` and `tsc -p e2e/tsconfig.json` passed. The first full `mise run
  test` (`full-tests-0042`, 722.5 s) failed only on known aggregate timeouts:
  [0213](../../tests/flaky-tests/backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md),
  [0175](../../tests/flaky-tests/environments-and-containers/0175-container-git-fetch-branch-baseline-timeout.md),
  [0192](../../tests/flaky-tests/environments-and-containers/0192-firewall-bootstrap-shell-timeout.md) and
  two split cases of
  [0165](../../tests/flaky-tests/coordinator-and-multi-review/0165-coordinator-bound-discard-timeout.md)
  (reopened). Each unchanged owning file passed alone at load 11. The second
  full run (`full-tests-0042-2`, 644.4 s) passed the workspace, bridges and
  protocol groups and failed only the root group on
  [0178](../../tests/flaky-tests/agent-bridges/0178-pi-vendor-runtime-aggregate-timeout.md)
  and another 0192 case; both owners passed alone.
- Not run: two machines, Firefox, Safari and iOS, Docker Desktop on Windows,
  real private DNS and certificates, the hostile worker against Electron's
  **Reset site data**, the Vite HMR case of the Chromium spec, a retention
  pass in a real Electron window, the full `mise run test:agent:electron`
  suite.

2026-10-22, review follow-up on `1ab33f742`, same macOS 26.6.2 arm64 host,
Bun 1.4.3, Node 24.21.0 and Playwright 1.64.0. Single-machine qualification;
transport and publication defaults remain unchanged.

- Forgotten-connection intent is persisted before clearing and retried
  independently of window transports, with 64 attempts per pass. Retention
  regressions cover 141 partitions, failed clears, releasing the last
  holding window, restart recovery, and a startup removal failure that must
  still attempt the native clear. Window holdings include shared sessions;
  schedule cancellation and shutdown stop recurring reconciliation.
- The throttle now waits for destination `drain`, includes unfinished socket
  writes in its queue accounting, and removes its listeners on teardown.
  A 32 MiB sustained-producer regression pauses the destination, observes
  admission plateau and upstream backpressure with at most 1 MiB queued,
  then resumes reading and verifies byte integrity and EOF.
- Handoff creation returns the attachment ID independently of the URL and
  releases it if grant consumption fails. Baseline orchestration regressions
  release IDs for missing URLs, invalid URLs and missing session codes, and
  retain compatibility with code-only responses. Default backend tests run
  the real `watch` and `download` subcommands against an isolated stack,
  including release after a missing tunnel credential.
- Passed through `mise run test:logged`: `mise run check`; the focused
  retention, baseline-tool, baseline-command and handoff command suites;
  `mise run test:preview:browser` (6 passed, 1 skipped: Vite fixture unset),
  including the hostile service-worker journey; and
  `mise run test:preview:bench` (both loopback suites, including all four
  baseline routes and attachment counts returning to zero).
- `mise run test:agent:electron`: 29 passed, 1 skipped (native Wayland on
  macOS), 145.8 s. The production forget IPC clears actual service and shared
  partition cookies while Local's cookie remains. Restarting the real main
  process removes both retired directories and preserves Local's directory.
  The extended multi-backend journey also passed alone after the final
  retention changes (12.4 s). Disposable profiles, fixture backends and PKI
  were stopped and removed by the harnesses.
- `mise run test:logged -- --name full-suite -- mise run test`: all four
  groups passed (453.7 s). After the final retention edge-case changes, the
  complete desktop package suite passed again (24.5 s), as did
  `mise run check` and the native multi-backend retention journey.
- No Docker, published-CLI or iOS scenario suite was added: this follow-up
  changes desktop retention and baseline tooling, with an additive backend
  handoff response. Vite HMR remains outside this run because its isolated
  fixture was not installed; the full Electron suite's own HMR journey passed.

2026-10-23, cross-service read policy, branch
`todo-0054-preview-cross-service-reads-bd9ab0d325bb` from `main` at
`06297124`. macOS, Playwright 1.64.0, Chromium 156.0.8078.4. Single machine;
Chromium only.

- Private origins now refuse cookie-authenticated reads from other sites and
  services unless they are top-level document navigations (details and
  decisions in
  [0054-preview-cross-service-reads.md](0054-preview-cross-service-reads.md)).
- `mise run test:preview:browser`: 7 passed, 1 skipped (Vite fixture unset).
  The hostile worker's credentialed `no-cors` `GET` no longer reaches the
  sibling application. A new case shows a fetch, an image and a frame from
  one service to its sibling refused before forwarding (three
  `http.rejected{forbidden}`), and a top-level link between them opening the
  sibling signed in. With the read check reverted, both cases failed.
- Not run: Firefox, Safari, a real Tailscale Serve forwarder.

2026-10-23, cross-service read review follow-up, same branch; macOS 27.0,
Playwright 1.64.0, Chromium 156.0.8078.4, Firefox 157.0, WebKit 27.2 and
Tailscale Serve 1.102.4. Single machine.

- `mise run test:logged -- --name preview-browser-cross-engine -- mise run
  test:preview:browser`: 24 passed, 3 skipped (Vite fixture unset), 80.8 s.
  All engines refuse sibling fetch/image/frame traffic before forwarding;
  top-level links work. The hostile worker reaches no sibling. WebKit blocks
  all six HTTP-loopback gateway probes in-browser; Chromium/Firefox reach
  the gateway without credentials and are refused.
- A synthetic external identity provider redirects a service's own iframe
  back to that service: Chromium sends cross-site/iframe metadata and is
  refused with `403`; Firefox/WebKit omit the Lax preview cookie and receive
  `401`. Each adds one `http.rejected{forbidden}`; nothing reaches the app.
  Direct same-origin frames and top-level returns through that redirect work.
  Hidden-iframe silent renewal is now an explicit framework limitation;
  refresh tokens, popup and top-level redirect flows are the documented path.
- `ORKESTRATOR_TEST_TAILSCALE_SERVE_METADATA=1 mise run test:logged --
  --name tailscale-metadata-live-final -- bun test --cwd apps/backend
  ./src/tailscale-serve-metadata.test.ts --parallel=1`: passed, one test,
  eight requests and 16 assertions. A live, temporary Serve HTTPS listener
  preserved `Sec-Fetch-Site`, `Sec-Fetch-Mode`, `Sec-Fetch-Dest` and
  `Sec-Purpose`, including prefetch/prerender. The received headers produce
  the expected policy verdicts. The client verified TLS; cleanup removed only
  the test listener, preserving existing configuration.
- Static checks, focused protocol/publication tests, spec loading and final
  iframe regressions passed. Full validation exited 1 (938.4 s), solely on
  the existing recurring-baseline 5000 ms timeout; its owner also failed
  alone (4 passed, 1 failed). Recorded as an unresolved observation in
  [0177](../../tests/flaky-tests/native-agents-and-transcripts/0177-driven-observation-baseline-timeout.md).
  All other workspace tasks and aggregate groups passed.
- This closes the Firefox engine and live header-preservation gaps in
  [0054](0054-preview-cross-service-reads.md). Shipping Safari/iOS, private
  browsing and real wildcard-DNS browser publication through `publicPort`
  remain open. No system DNS, trust-store or production-profile edits.

2026-10-25, node retention, tunnel liveness, compatibility cases, legacy tab
history and UI items, branch `todo-0042-service-preview-rollout-f64ae24ade8a`
from `main` at `00a0cb82`. Single machine; nothing here is two-machine,
shipping Safari, iOS, Windows or real DNS evidence.

| Item | Version |
| --- | --- |
| Host | macOS 27.0 (26A425, arm64), shared with other live-test worktrees (load average 21 to 80) |
| Bun / Node (mise) | 1.4.4 / 22.23.1 (Bun 1.4.2 on `PATH` for direct `bunx` runs) |
| Electron / Playwright | 45.0.0 / 1.64.0 |
| Browsers | Chromium 156.0.8078.4, Firefox 157.0, WebKit 27.2 (Playwright builds) |

- Effective capabilities: defaults everywhere (`transport`, `relay` and
  publication off); the Electron spec turns the transport on with
  `ORKESTRATOR_PREVIEW_TRANSPORT=1` on its disposable profiles, and adds
  `ORKESTRATOR_AGENT_TEST_PREVIEW_RETENTION_MS` for the retention case. No
  default changed and the legacy route was not touched.
- Compatibility cases, `mise run test:logged -- --name preview-browser --
  mise run test:preview:browser`: passed (55.3 s); with the list reporter 42
  passed and 3 skipped (Vite HMR, fixture unset), 14 passed per engine. The
  six new tests passed 54 of 54 with `--repeat-each=3`. Observed:
  - `srcset`: pixel ratio 1 loads `small.png`, 2 loads `large.png`, from the
    service origin (the fixture now serves real PNGs; both paths were 404).
  - Source maps: the `sourceMappingURL` resolves against the script and the
    map loads from the page's origin with `application/json` and the exact
    bytes; Chromium's `Debugger.scriptParsed` reports the same map URL.
  - SPA: `/app/deep/route?x=1#h` loads directly after sign-in; `pushState`,
    reload, Back and Forward keep the path and state; sign-in adds no history
    entry; no visited URL holds `__orkestrator_preview`, the grant or the
    attachment id.
  - Isolation between `app` and `other` (a second `app` page as the positive
    control): IndexedDB, BroadcastChannel, Cache Storage and the `/sw.js`
    worker are all invisible to the sibling.
  - Frames and popups: bootstrap, session and refusal pages carry
    `X-Frame-Options: DENY` and `frame-ancestors 'none'`; framed from another
    site, the bootstrap (405), a bad session code (403) and the signed-in
    service (401, the Lax cookie is not sent) render nothing and the fixture
    sees no request. The web client's popup flow lands with
    `window.opener === null`; a plain cross-site `window.open` keeps its
    opener, because private origins add no COOP (now documented in
    `browser-previews.md`).
  - IPv6: a fixture bound only to `::1`, registered with `addressFamily:
    "auto"`, loads and its WebSocket works. The harness had faked the family
    probe to always fail; it now uses the real `defaultProbeFamily`.
  - Not tested: a framed bootstrap POST with a valid grant. By code reading
    the bootstrap and session-code paths do not check Fetch Metadata, so such
    a POST would probably use up the grant while its page cannot render; it
    needs the one-use grant in hand, so it was not pursued.
- Real Electron, `bunx playwright test --config
  e2e/agent-testing/playwright.electron.config.ts service-preview-electron.spec.ts`:
  17 of 17 in 3 consecutive runs (141, 239 and 226 s, load 23 to 46) after
  test-side fixes (a cookie without expiry could not survive the relaunch;
  the relaunch reopens on the second backend; a one-shot visibility read).
  - Retention: see code item 4 (cookies cleared 31.1 to 32.3 s after removal,
    directory removed after relaunch, sibling kept).
  - Reset site data with the hostile worker (`/sw-hostile/install`) and the
    benign `/sw.js` at scope `/sw/`, plus a cookie, localStorage and
    IndexedDB: before, 2 registrations, the hostile worker answering
    `/__orkestrator_preview/…` and `/sw/marker` answered by the worker;
    after **Preview options → Reset this site's data**, no controller, 0
    registrations, `/sw/marker` answered by the fixture (404), all storage
    and the server-side cookie empty; the page reloads through the tunnel and
    `svc-b` keeps its cookie, storage and worker.
  - Legacy URL tab history: see code item 8 (12 bounces before the fix; 5 of
    5 rounds and both deterministic cases held after).
- Full Electron suite: `svc0042-suite-1` (583.5 s, load 43 to 60) 31 passed,
  3 failed, 5 skipped or not run; the service-preview spec passed 17/17. The
  failures: [0515](../../tests/flaky-tests/electron-and-desktop/0515-electron-nickname-reload-timeout.md)
  (recurrence, with [0157](../../tests/flaky-tests/electron-and-desktop/0157-electron-first-window-startup-timeout.md)
  in the first owner rerun), new [0940](../../tests/flaky-tests/previews-annotations-and-gateway/0940-annotation-late-font-fixture-reload-timeout.md)
  (an A/B of that test passed 2/2 with and without the new throttling
  switches) and new [0941](../../tests/flaky-tests/electron-and-desktop/0941-workspace-realm-profile-cleanup-enotempty.md);
  each unchanged owner passed alone. `svc0042-suite-2`: 38 passed, 1 skipped
  (Linux Wayland), 0 failed, 376.4 s. Since #1265 `closeElectronWithin`
  called `app.process()` after Electron quit and threw, which also broke the
  multi-backend relaunch; `design-electron-cleanup.ts` now tolerates the
  disposed handle.
- Unit and focused suites, through `mise run test:logged`: desktop retention
  (10 new node tests), tunnel client and server (new liveness tests; the
  server one fails with the client-ping handling removed), protocol
  WebSocket, `disk-report`, runtime profile (14), desktop manager and IPC
  (111), web browser tabs, pane layout and preview entry (563 across 28
  files), and the backend preview files that use the fixture.
- Repository checks: `mise run check` (format, lint, typecheck) and
  `bun check -p e2e/tsconfig.json` passed. The first full `mise run test`
  (`full-tests-0042`, 1768.1 s) failed only on two defects in this change,
  both fixed: a DOM query passed to `toBeNull` in `ServiceBrowserTab.test.tsx`
  and the moved toolbar classes in `tests/unit/mobile-responsive-contracts.test.ts`.
  The second (`full-tests-0042-2`, 1653.8 s, load 38 to 48) passed the root,
  bridges and lockfile groups and failed the workspace group on five
  backend timing failures in untouched files; every owner passed alone
  (environment-move on its second rerun). After rebasing onto `main` at
  `26b51f144` (which brought in #1258, preview service discovery),
  `mise run check`, the touched web, desktop and backend preview suites and
  `mise run test:preview:browser` passed again; the third full run
  (`full-tests-0042-3`, 1765.9 s) failed only on two backend timeouts in
  untouched files (terminal history, environment-move restart recovery),
  whose owners passed alone. Recorded as
  [0942](../../tests/flaky-tests/aggregate-validation-runs/0942-service-preview-rollout-0042-validation.md).
- Two-machine tool and bench: not rerun (no change to them).
- Not exercised: node-partition retention against a real command node with a
  forgotten node (unit tests only); the narrow toolbar in a real window (class
  contracts only); the 2026-10-21 cross-client layout miss (code item 9).
- Cleanup: the specs removed their temporary roots and stopped Electron,
  both backends and every fixture; no temporary root or Electron process was
  left; the A/B spec and config were deleted. No containers were used.
  Evidence: `output/agent-testing/svc0042-*`.

## Constraints and rationale

- The threat boundaries, the credential and data path, and the resource-owner
  table are in
  [browser-previews.md](../../architecture/browser-previews.md) §"Security
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
  its admission slot: until the 30-second liveness ping closes it if the
  client is gone, or until the tab closes while the desktop keeps pinging
  (2026-10-25, decision D2).
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
- A window's previews belong to their connection (2026-10-21). Before, the
  preview transport resolved "this window's connection" at each call. Main
  moves the window (and, on close, releases it) before tearing the old
  transport down, so the old attachments were released on the new backend,
  which answered `released: false`, or not at all once the window was gone;
  the issuing backend kept them until the 30-minute idle expiry. `connect`
  and `forget` also moved the window without rebuilding its previews, so its
  old views stayed and its next service opened in a partition keyed to the
  old connection. Now each transport is fixed to the connection it was made
  for (`connectionPreviewBackend`, keeping the last client it saw for
  teardown), and `use`, `connect` and `forget` all end the window's previews
  when its connection changed (`rebindWindowPreviews`). Rejected options:
  - Disposing the old transport before switching: a failed switch (an
    unreachable remote) would leave the window on its old connection with its
    previews gone.
  - Keeping a remote client alive while any transport references it: the same
    outcome with shared bookkeeping in `ConnectionManager`; the transport
    holding its last client only for teardown is enough.
  Cost: a disposed transport may still reach a remote no window holds, with
  that connection's own token, for its release calls only.
- Mixed versions: old clients show service URIs unchanged and refuse them
  (`browser-address.test.ts`). Pre-#831 backends reject Auto mappings
  (`hostPort: 0`).

## Open questions

- How long is the support window for the legacy route and the pre-preview
  layout schema? Should compatibility mode remain as an explicit fallback
  after the desktop default flips? (Partly answered 2026-10-24: the window is
  published releases from the floor, the newest Stable at least 60 days old;
  see [`version-compatibility.md`](../../architecture/version-compatibility.md).
  The legacy route can go once the floor is at or above the first Stable
  release with service previews as the desktop default, and stored legacy
  URL tabs have a migration. `preview.legacy-loopback-route` counts its
  requests. The fallback question stays open; recommendation in D8.)
- Is it acceptable that annotations on legacy URL tabs keep needing the legacy
  route? (Recommendation in D8.)
- What observation window and thresholds apply to each cohort, and who signs
  off? (Proposed starting point in D8; needs the two-machine baseline.)
- Answered 2026-10-25 (decision D3): the preview browser and Docker suites
  join change-gated validation, not CI. The testing guide's "Verification by
  change type" table and `AGENTS.md` now name `mise run test:preview:browser`
  (and `test:preview:docker`, `test:agent:electron`) for changes to preview
  origins, forwarding, resolution, the relay or the fixtures.
- Answered 2026-10-25 (decision D2): tunnel liveness outlasts a reader paused
  by backpressure. The desktop pings the backend every 15 seconds and the
  backend counts any client frame as liveness, so a stalled but live reader
  keeps its tunnel; a silent client is still closed after 30 to 60 seconds.

## Assumptions and decisions

Recorded 2026-10-25 for the work done on branch
`todo-0042-service-preview-rollout-f64ae24ade8a`.

- **D1. How node partitions learn that a node was removed.** Options: (a)
  intercept `forget_node` in Electron; (b) treat a node as removed when any
  command node's `list_nodes` lacks it; (c) remember which command
  connections listed each node and forget it once all of them have dropped
  it, moving vouchers on a command handover. Chose (c). The renderer calls
  `forget_node` straight through the gateway, so (a) misses forgets from
  other clients and the CLI; (b) would wipe site data when a handover moves a
  node away from its old command node. Pros: needs only an authoritative
  registry read on the existing 30-minute schedule; unreachable, suspended or
  malformed registries never count as removal. Cons: a node removed while no
  window uses its command node is cleaned up only when one does; a journal
  (`preview-partitions-pending.json.nodes`, at most 1,024 nodes and 8 command
  connections each) is one more file; forgetting a command connection also
  forgets nodes reached only through it, as for its own partitions.
- **D2. Tunnel liveness behind backpressure** (was an open question).
  Options: keep closing stopped readers after 30 to 60 s; a longer stall
  deadline that resets on drain; liveness on a channel not behind application
  data. Chose the third, as client pings: the desktop sends a WebSocket ping
  every 15 s (`PREVIEW_TUNNEL_CLIENT_PING_MS`) and the backend counts any
  inbound frame as alive (`preview-tunnel-server.ts`; `PreviewWebSocket` now
  emits `ping`). Pros: a paused-media tab keeps its stream, which matches the
  invariant that inactivity never cancels application work; dead clients are
  still detected; no frame format change, and both mixed-version pairings
  behave as before. Cons: a live desktop whose reader never resumes holds
  the queue, one read and an admission slot until the tab closes (the
  admission bound still caps the total); the upload direction is unchanged (a
  backend paused on a slow upstream cannot read the client's pings, so that
  tunnel is still closed by liveness).
- **D3. Gated runs for the preview suites** (was an open question). Options:
  add the browser suite to CI; a scheduled workflow; change-gated through the
  validation rules review preparation reads. Chose change-gated. CI runs no
  browser today; adding three engines would add their download and about a
  minute to every run, and a workflow cannot be proved from a worker. Pros:
  runs exactly when preview code changes. Cons: relies on the reviewer or
  review preparation selecting it; nothing catches drift from unrelated
  changes.
- **D4. "Open as service" scope.** Options: offer it whenever the port
  matches a service; require the tab's environment, current epoch, one
  claimant and an available endpoint, and re-check on click. Chose the strict
  rule (the item's own "never infer ownership from the port alone"). Cons:
  tabs whose service is stopped or whose port is shared get no offer.
- **D5. Narrow toolbar.** Options: let controls shrink on one row; wrap
  earlier. Chose both: wrap below 672 px, and on one row the picker shrinks
  first with an address minimum. Con: in narrow panes the address sits below
  the buttons but still comes before them in tab order.
- **D6. Pane-layout echoes (item 9).** No store change: the guards exist and
  a regression test now fails without them. The remaining doubt is a live
  check, left open in item 9.
- **D7. Measuring partition disk use.** Added preview partition rows to
  `mise run disk:report` (service and shared legacy partitions, with how many
  are cleared and waiting for the next start) rather than a one-off `du`, so
  a long-lived profile can be measured by anyone.
- **D8. Remaining open questions** (support window fallback, annotations on
  legacy URL tabs, cohort thresholds and sign-off) are product calls that
  need the maintainer and a two-machine baseline. Recommendation recorded,
  not adopted: keep compatibility mode as an explicit, labelled fallback for
  one Stable release after the desktop default flips, then retire it with the
  legacy route; annotations on legacy URL tabs go with the route (offer
  **Open as service** first); thresholds come from the two-machine baseline
  (a proposed starting point: p95 first byte and connect time within 1.5×
  the direct route over the same link, no
  unbounded queue growth, and zero cross-service reach), signed off by the
  maintainer.

## Needs verification

- How much disk the `orkestrator-preview-svc-*` partitions take on a
  long-lived profile. One data point (2026-10-22, the maintainer's macOS
  production profile, read-only `du`): 2 service partitions, 5.8 and 9.4 MB,
  mostly Chromium caches (GPU and Dawn caches, Code Cache, Cache) created even
  after light use; 16 shared legacy partitions, 93 MB in total. Retention of
  service partitions now exists; the shared legacy ones (code item 4) are the
  larger share. A profile with many services over months is still unmeasured.
  Since 2026-10-25 `mise run disk:report` reports both partition kinds
  (decision D7). A second data point, this host's production profile
  (macOS 27, read-only): no service partitions and one shared partition,
  172 kB.

## Related

- [browser-previews.md](../../architecture/browser-previews.md) (operator guide),
  [remote-gateway.md](../../architecture/remote-gateway.md) §"Service previews".
- [0054-preview-cross-service-reads.md](0054-preview-cross-service-reads.md)
  (found by the hostile service-worker run),
  [0046-embedded-service-previews.md](0046-embedded-service-previews.md),
  [0045-preview-service-discovery.md](0045-preview-service-discovery.md),
  [0044-web-annotation-qualification.md](0044-web-annotation-qualification.md) (same
  Electron harness; annotations run inside service tabs).
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
  for batching the macOS, Electron, two-machine and Safari runs;
  [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md)
  for Docker Desktop.
- [0018-container-network-and-credential-isolation.md](../containers-and-environments/0018-container-network-and-credential-isolation.md):
  egress policy must keep published loopback ports and relay stdio working.
- [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md) (support
  window), [0023-environment-and-disk-cleanup.md](../containers-and-environments/0023-environment-and-disk-cleanup.md)
  (deletion-time cleanup), [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md)
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
