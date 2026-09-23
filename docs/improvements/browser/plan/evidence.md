# Browser preview validation evidence

Status: Recorded 2026-09-23 on branch `webbrowser-functionality-cfc4abe48d47-r1`.
Base commit `88c2f9cc`. Evidence was taken after the step 13 commit (`e8094ec4`)
plus the step 14–15 changes committed with this file.

This is the step 14 evidence log. Each row names the command that produced it.
A row marked **Not run** is not supported, and its capability stays off or
unadvertised. Results from one platform are not used to claim another.

## Environment

| Item | Version |
| --- | --- |
| Host | Linux 7.2.5 (x86_64), one machine |
| Bun | 1.4.2 |
| Node (host / container image) | 26.7.0 / 24.21.0 |
| Docker Engine | 29.7.2 (Linux, not Docker Desktop) |
| Container image | `orkestrator-v2:latest` (local build) |
| Chromium | Headless shell 153.0.8010.12 (Playwright 1.63.0) |
| Vite fixture | 7.3.6, installed to `/tmp/preview-vite` (isolated copy) |

Every run used a temporary data directory, throwaway PKI, and synthetic
fixtures. Opt-in Docker tests label their containers with a throwaway owner
namespace and remove them afterwards. Afterwards, `docker ps --filter
label=environment-id=a` showed no leftover containers.

## Automated suites

| Layer | Command (from repo root unless noted) | Result |
| --- | --- | --- |
| Protocol | `cd packages/protocol && bun test src/preview-{forward,http1,services,websocket}.test.ts` | 57 pass, 0 fail |
| Backend | `cd apps/backend && bun test` on all 11 preview files, opt-in gates on (see below) | 91 pass, 0 fail |
| Root and Electron | `bun test` on the 9 `tests/unit/electron/*preview*` files, `gateway-preview`, `ios-mobile-contracts`, `package-config`, `EnvironmentSettingsDialog` | 136 pass, 0 fail |
| Web | `cd apps/web && bun test` on the 8 preview, service-tab, and address files | 41 pass, 0 fail |
| Real Chromium | `ORKESTRATOR_TEST_PREVIEW_VITE_DIR=/tmp/preview-vite bunx playwright test --config e2e/preview/playwright.preview.config.ts` | 6 pass, 0 fail |
| Format, lint, types | `mise run test:logged -- --name preview-check -- mise run check` | Pass |
| Affected tests | `mise run test:logged -- --name preview-changed -- mise run test:changed` | See below |

The opt-in gates were enabled with these variables:

- `ORKESTRATOR_TEST_DOCKER_PREVIEW_IMAGE=orkestrator-v2:latest`
- `ORKESTRATOR_TEST_DOCKER_RELAY_IMAGE=orkestrator-v2:latest`
- `ORKESTRATOR_TEST_PREVIEW_VITE_DIR=/tmp/preview-vite`
- `ORKESTRATOR_PREVIEW_BENCH=1`

The first `test:changed` run failed in three groups:

- **Root:** two expectations still described the pre-preview layout: the
  environment settings tab list, and the window-close cleanup text in
  `package-config`. Both were updated and now pass (included in the root row).
- **Workspace:** one backend test file was edited while the run was reading
  it. The test passed 6 of 6 times in isolation afterwards.
- **Bridges:** the watchdog killed `cursor-bridge` after 300 s with no output.
  An isolated rerun (`bun run test:bridge` in `bridges/cursor-bridge`, 2
  workers) also hung and was killed after 600 s. This branch changes no files
  under `bridges/`. It changes none of the protocol modules `cursor-bridge`
  imports; the only overlap is new export entries in
  `packages/protocol/package.json`. The hang has not been diagnosed, and it
  still needs a flake-registry entry or a check against `main`.

## Journeys (step 14)

| # | Journey | Evidence | Result |
| --- | --- | --- | --- |
| 1 | Local worktree service, entry button, terminal link | `pane-layout-preview-targets`, `ServiceBrowserTab`, `TerminalContainer.helpers` (component) and `preview-transport-manager` (real sockets) | Pass: component and socket level only, no real Electron window |
| 2 | Two containers on the same internal port plus a host decoy | `core/preview-docker.test.ts` (real Docker) | Pass: each service returns its own marker and never reaches the decoy |
| 3 | Remote client on another machine | none | **Not run.** Needs a second tailnet machine |
| 4 | Recreate, rebind, and reuse the old port for another app | `core/preview-docker.test.ts` | Pass: the service follows the recreated container, and the generation changes |
| 5 | Switch environment, change state, return, reload | `preview-service-registry` (snapshots and epochs), `previewServiceStore` | Pass: backend and store level |
| 6 | Two services with colliding cookie and storage names | `e2e/preview/private-origin.spec.ts` (Chromium); `preview-transport-manager` (partition naming) | Pass on private origins in Chromium; Electron partitions verified at unit level only |
| 7 | Grant replay, cross-site writes and upgrades, control routes | Chromium spec (replay, sibling POST refused by the backend), `preview-publication.test.ts` (control and reserved paths, cross-site upgrade) | Pass. A hostile service worker was not tested (see limitations) |
| 8 | Rotate or revoke during HTML, upload, SSE, app WS, and tunnel | `gateway-preview` (rotation, rollback drill with an SSE stream), `preview-tunnel-server` (revocation, generation), `preview-publication` (revocation), Chromium spec (session revocation) | Pass |
| 9 | Close and reopen views, windows, and backends | `preview-transport-manager` (hide, retire, dispose), `browser-preview-manager` | Pass at unit level. Real Electron, renderer crash, and iOS backgrounding **not run** |
| 10 | External handoff and fallbacks, with no credential in a URL | `preview-external-handoff`, `preview-external`, Chromium bootstrap spec | Pass. Popup denial and framing fallback are unit-tested only |

## Compatibility

| Case | Evidence | Result |
| --- | --- | --- |
| Root-relative assets, module scripts, CSS | Chromium spec (`data-loaded`, CSS custom property) | Pass |
| Streaming HTML before the upstream finishes; SSE | `preview-forward`, `preview-tunnel-server`, rollback drill (`/sse`) | Pass |
| Binary bodies, exact hashes, uploads | `preview-forward`, relay tests (512 KiB upload, sha256) | Pass |
| 304, 206, duplicate `Set-Cookie`, `__Host-` cookies | `preview-forward`, `preview-publication` | Pass |
| App bearer auth and cookies preserved; transport cookie stripped | `preview-publication`, `gateway-preview` | Pass |
| WebSocket subprotocol, in a real browser | Chromium spec (`fixture.v1`) | Pass |
| Vite 7.3.6 page, module graph, HMR | `preview-vite.test.ts` (transport), Chromium spec (DOM updates, no reload) | Pass, with **no** Vite configuration |
| HTTPS upstream verification (wrong name, untrusted) | `preview-publication` | Pass |
| IPv6-only targets | `preview-target-resolver` (inspection and family) | Pass at resolver level |
| gzip/Brotli representations | `preview-forward` ("compressed representations pass through byte-exact") | Pass: encoded bytes and `content-encoding` unchanged |

## Resource and failure bounds

| Case | Evidence | Result |
| --- | --- | --- |
| Tunnel admission per service; release on close | `preview-tunnel-server` | Pass |
| Stalled reader cannot grow the tunnel queue | `preview-tunnel-server` | Pass |
| Headers stall, endless body, oversized bodies | `preview-forward`, `gateway-preview` (legacy headers deadline) | Pass |
| Relay: stalled channel does not block siblings; channel cap; crash backoff; deliberate stop is not a crash | `preview-relay-supervisor` | Pass |
| Probe concurrency and queue bounds | `preview-target-resolver` | Pass |
| No secrets in logs, diagnostics, or events | `preview-tunnel-server` ("never carry credentials…") | Pass |

## Route latency (loopback, one machine)

Command: `ORKESTRATOR_PREVIEW_BENCH=1 bun test src/preview-bench.test.ts`, run
from `apps/backend`. Each sample opens a fresh connection, sends one
`GET /health`, and measures the time to the first response byte. There are 200
samples after 10 warm-up requests.

| Route | p50 (ms) | p95 (ms) |
| --- | --- | --- |
| Direct TCP to the fixture | 0.31 | 0.37 |
| Desktop tunnel (WS, HELLO, OPEN, request) | 1.02 | 1.19 |
| Private origin (TLS handshake and request) | 2.11 | 2.62 |

These are single-machine loopback numbers. They show fixed per-connection
overhead only, not tailnet latency. The legacy route was not benchmarked.
Release thresholds need a two-machine baseline, which has not been run.

## Not run (capabilities stay off or unadvertised)

| Row | Why | Consequence |
| --- | --- | --- |
| Two-machine tailnet (journey 3, client-local fallback, real latency) | No second machine | Keep remote desktop previews opt-in |
| Firefox, Safari, WKWebView, iOS device or simulator | Unavailable here | Embedded modes stay unadvertised; the iOS handoff has contract tests only |
| Docker Desktop (macOS and Windows) | Linux Engine only | Relay and resolver are unverified there |
| Real Electron window (partitions, zoom, overlays, DevTools, renderer crash) | Would open windows on the operator's desktop; not run from this session | Run `mise run test:agent:electron` in an isolated profile before enabling the desktop default |
| Real private DNS and Tailscale certificates | Needs operator infrastructure | Publication needs a per-deployment check (see the operator guide) |
| Hostile application service worker during re-bootstrap | No fixture yet | Documented limitation: clearing site data recovers |
