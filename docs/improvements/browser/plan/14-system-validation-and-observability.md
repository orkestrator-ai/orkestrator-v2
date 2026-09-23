# 14 — Validate the system and add operational evidence

Status: Not started. Depends on: all steps in the release being enabled.
Full core validation covers 01–12; include 13 only when shipping the relay.
Repeat the relevant gate for each delivery group, not every unrelated test.

## Outcome

Prove that correct routing, compatibility, auth isolation, and cleanup hold across
real client/backend boundaries. Publish a support matrix backed by reproducible
tests, and provide safe diagnostics for field failures.

Follow the [testing guide](../../../development/testing-guide.md) and
[isolated agent guide](../../../development/agent-testing.md). Extend focused
owner tests plus separate preview specs alongside
[agent browser tests](../../../../e2e/agent-testing/browser-gateway.spec.ts) and
[agent Electron tests](../../../../e2e/agent-testing/electron-main.spec.ts).
Keep fixtures separate from the live source checkout and user's data/containers.

## Test layers

| Layer | What it must prove |
| --- | --- |
| Protocol/pure helpers | Validation, bounds, error discriminants, origin/path mapping, secret redaction |
| Backend registry/storage | CAS updates, generations, lifecycle races, restart, missed-event reconciliation |
| Real local socket integration | HTTP bytes, streaming, WS/tunnel framing, admission, cancellation, timeout cleanup |
| Browser component tests | Service selection, errors, capability gating, migration-driven UI |
| Real browser/gateway | Authenticated bootstrap, origins, cookies, workers, framing, HMR, controls |
| Real Electron | Main/preload/IPC, partitions, WS auth, native geometry/history/annotations, shutdown |
| Owned Docker fixtures | Mapping versus container loopback, recreation, decoy ports, optional relay |
| Two-machine tailnet | Client-local fallback, TLS/publication, remote network loss, actual latency |
| Safari/iOS device or simulator | WKWebView policies, background/foreground, cookie/embedding fallback |

Mocks are appropriate at narrow ownership boundaries, not as proof that browser
networking or Docker mapping works. Any mock-only claim stays labeled as such.

## Required end-to-end journeys

1. Open a local worktree service from its entry/registered service and a terminal
   link. Exercise navigation, app authentication, streaming, and HMR.
2. Repeat with two containers using the same internal port; bind a decoy server
   at that number on the backend host. Verify service markers and upstream
   request logs from synthetic fixtures, not just page-load status.
3. Repeat remotely with client and backend on different machines. Ensure no
   request lands on the client-local decoy service.
4. Recreate a container, change its host binding, and reuse the old port for
   another fixture. The original tab must reconnect to its original service.
5. Start in environment A, switch to B, let the service finish startup or lose
   connectivity, then return and reload. Verify snapshot-based recovery.
6. Open two independent services and deliberately collide cookie/storage names,
   BroadcastChannels, and worker scopes. Verify intended isolation.
7. Bootstrap after an app has installed a hostile service worker. Attempt grant
   replay, forged messages, cross-site upgrades, and control-route access.
8. Rotate credentials/expire access during HTML transfer, upload, SSE, app WS,
   and desktop tunnel. Verify revoked resources close and new requests deny.
9. Close/reopen views and windows repeatedly; exercise renderer crash, backend
   restart, network suspension, and iOS backgrounding. No orphan listeners or
   agent/server termination from UI unmount.
10. Test browser external handoff, cookie-blocked embedding, framing denial,
    popup denial, and documented fallback without credentials in URLs.

## Compatibility fixtures

Maintain a deterministic base fixture plus pinned real-framework fixtures.
Cover root-relative assets, `srcset`, dynamic imports, deep links/history,
service workers, CSP/SRI, `__Host-` cookies, app bearer/basic auth, same-service
redirects, OAuth-style external redirects, uploads/downloads, 304/206, and
gzip/Brotli representations. Include WebSocket subprotocol/binary cases and
chunked streaming HTML whose first chunk arrives before completion.

Run with localhost/IPv4/IPv6 targets and supported HTTPS certificate cases.
Document required public-origin/HMR/allowed-host configuration for each pinned
framework. A framework's hardcoded unrelated localhost API is a configuration
limitation, not evidence that arbitrary transparent proxying is promised.

## Metrics and failure artifacts

Add bounded counters/gauges/histograms for active service definitions,
attachments, pending grants, HTTP admissions, upgrades/tunnels, relay processes,
queue bytes, decode/compression bytes, time to connect/headers, reconnects,
revocations, and safe failure category. Keep label cardinality bounded by
transport/failure/platform categories; do not label by full URL or arbitrary
user strings. A bounded internal correlation ID can join lifecycle records.

Expose a safe diagnostics snapshot through the trusted control API. Do not let
preview credentials read backend-wide metrics. Test that fixture secrets, app
headers, page bodies, terminal content, and query parameters cannot appear in
logs, screenshots selected for reports, traces, or persisted artifacts. Use
existing artifact scrubbing/retention patterns.

## Resource and performance gate

Exercise each step-02 ceiling and just-over-limit case. Assert slot/buffer/timer
release, bounded retained state, and a clear overload result. Test many quiet
connections, one large stream, many tiny frames, a stalled upstream, and slow
downstream consumers. Include expected protocol closure rather than silently
dropped application data.

Compare direct, legacy, desktop-tunnel, and dedicated-origin routes using the
same fixtures and network conditions. Record p50/p95 connect and first-byte
times, HMR delivery/reconnect, peak queue/decode bytes, CPU, and socket counts.
Set release thresholds from the step-01 baseline and product target before
calling the run a pass. Do not invent percentage improvements without data.

Non-negotiable behavior: streaming HTML starts before end; paused consumers do
not grow queues indefinitely; unrelated control traffic and services continue;
revocation cleans all associated resources within the specified cleanup bound;
no tests pass only when the environment remains active.

## Validation commands and evidence

Choose explicit owner paths as files are implemented, through the logged runner:

```bash
mise run test:logged -- --name preview-focused -- \
  bun test ./tests/unit/electron/browser-preview-manager.test.ts \
  --parallel=1 --only-failures
mise run test:changed
mise run test:logged -- --name preview-check -- mise run check
mise run test
```

Also run the relevant existing `test:browser`, `test:agent:browser`,
`test:agent:electron`, `test:agent:docker`, and supported iOS workflows according
to their prerequisites in the operator guides. These are required selections
for affected surfaces, not commands to run blindly without an isolated profile.
Two-machine validation needs its own reproducible runbook and cannot be replaced
by the root unit suite. Follow the existing flake registry process on failures.

Each evidence entry records commit, fixture/client/platform versions, effective
capabilities, commands, results/counts, safe artifact location, skipped cases
with reasons, and profile/container cleanup. Exit when every enabled capability
has its matrix rows passing. Unsupported modes remain disabled rather than
being inferred from a neighboring platform's result.
