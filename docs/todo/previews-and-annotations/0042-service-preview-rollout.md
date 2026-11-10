# Service preview rollout

Checked against `main` at `2459b05c` (2026-10-15); real-Electron runs against
`a5d338c1` (2026-10-18) and `9b3f53a2` (2026-10-21); partition retention,
fault tests and single-machine runs against `b83ae534` (2026-10-22); node
retention, tunnel liveness, compatibility cases and UI items against
`00a0cb82` (2026-10-25); the preview flakes (task 11) against `93b99bfba`
(2026-11-01); the Next.js fixture (task 5) and task 6's metric additions
against `7b48c23fb` (2026-11-03); the default flip and legacy tab migration
(tasks 7 and 8) against `4e3caa079` (2026-11-04); the 0622 window-close cause
(task 11) against `e6c3da899` (2026-11-06); the task 10 Electron cases
against `ee2cc8423` (2026-11-06).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

4. **Docker Desktop on Windows**: binding inspection, Auto ports, recreation
   and the exec relay. Status: not needed (2026-11-04): the maintainer put
   Windows out of scope, so no default waits on it (D18).
5. **Remaining compatibility cases**: a streaming or router framework
   fixture. Status: done (2026-11-03): the Next.js 16.4.3 app-router fixture
   and its spec pass in Chromium and Firefox (WebKit not run on beelink,
   2680). The real-provider OAuth run (deferred, D13) needs a real provider
   sign-in and moved to the manual-test checklist (7568).
6. **Performance thresholds and missing metrics**: set thresholds from the
   two-machine baseline under the pass rule the maintainer approves; add HMR,
   reconnect and desktop-ingress measurements. Status: blocked (waits on
   7568: 0042 task 1, the baseline, and 0042 task 6, the pass rule); metric
   additions done (2026-11-03:
   desktop reconnect counts and ingress connect and first-byte series; HMR
   delivery stays with the latency script).
7. **Flip defaults and cohort sign-off**: tunnel and relay defaults, the
   observation window and who signs off. Status: done (2026-11-04): both
   default on, on the maintainer's sign-off with no observation window (D19).
   The evidence the flip went ahead of is task 6 and the two-machine run
   (7568: 0042 task 1).
8. **Retire the legacy route and compatibility mode**: code item 6, once the
   maintainer has made the fallback and legacy-tab annotation calls and the
   floor has reached the first Stable release with the default. Status:
   blocked (waits on 7568: 0042 task 8, then on that release). Stored tabs
   that match one service now migrate (D21).
9. **Shared legacy partition retention**: the remaining half of code item 4.
   Status: blocked (on task 8, and waits on 7568: 0042 task 12, the
   long-lived profile reading the window is set from): the shared partitions
   serve legacy URL tabs until that route is retired.
10. **Real-window leftovers**: the pane-layout announcement (item 9), node
    retention against a real command node, and the narrow toolbar measured in
    a window (item 11). Status: done (2026-11-06): two Electron spec cases
    show another client's layout save reaching the open window (also while
    its environment is not shown) and measure the toolbar at a 519 px pane;
    node retention stays at unit level, as recommended (D27).
11. **Preview flakes 0620 and 0622**: code items 12 and 13. Status: done
    (2026-11-06): 0620 and the 0622 baseline-count race were fixed on
    2026-11-01 (D9 to D11). The 0622 window-close symptom was reproduced under
    CPU load and fixed (D22, D23); both flakes are resolved. The owning specs'
    launcher now recovers a startup that lost its modules to
    `ERR_NETWORK_CHANGED`, which failed them at review validation (D24).

Done and on `main` (`f47398fd`, #1280, 2026-10-25): code items 1 to 3, 5, 7,
8 and 10, node-partition retention, the real-window retention pass, Reset site
data with a hostile worker, tunnel liveness (D2) and gated runs (D3).

### 4. Docker Desktop on Windows

**Problem.** The relay and Auto mappings are proved on Linux Engine and Docker
Desktop for macOS, not Windows. It gates the relay default.

**Context.** Also tracked in
[0019](../containers-and-environments/0019-container-platform-qualification.md).

**Investigation.** The suite is `mise run test:preview:docker`; nothing in it
is Windows-specific. On 2026-11-04 the maintainer said Windows support is not
needed now, so the question below is settled by D18 and the run is not
scheduled.

**Decisions.**

- **Gate the relay default on Windows?**
  - **Yes, keep relay off until Windows passes (recommended).**
    - Pros: a default must hold for every supported desktop.
    - Cons: macOS and Linux users wait for a Windows host.
  - **Flip per platform (macOS and Linux first).**
    - Pros: earlier benefit.
    - Cons: a platform-specific default the settings model does not have today.

### 5. Remaining compatibility cases

**Problem.** Only Vite 7.3.6 (and the repository's Vite 8) and a plain fixture
were covered; a streaming or router framework and real OAuth had not run.
Since 2026-11-03 the framework half is covered. Real-provider OAuth has
still not run and stays deferred (D13); it needs a real provider sign-in, so
it moved to the manual-test checklist (7568).

**Context.** Synthetic external redirects are covered since 2026-10-23.

**Investigation.** `test-fixtures/` had only `preview-app`, `preview-vite`,
`agent-project` and `test-diagnostics`; no Next.js, Remix or Astro fixture.
`test-fixtures/preview-next` (Next.js 16.4.3, React 19.3.1, exact pins) and
`e2e/preview/next-app-router.spec.ts` now cover a streamed Suspense boundary,
hydration, client-side router navigation and deep links, a Server Action,
the request a route handler sees, an absolute redirect and Fast Refresh over
the HMR socket, all through the private origin (see the 2026-11-03 evidence
entry). The first run found a real gap: Next.js builds `request.url` from
`X-Forwarded-Proto` and its own port, so a route handler's absolute redirect
pointed at `https://localhost:<appPort>`, which `mapLocation` did not map,
and the browser left the preview. `mapLocation` now maps the private origins
under the public scheme on the same port (D12).

**Decisions.**

- **Which framework?** Chose the Next.js fixture (2026-11-03, D14).
  - **A minimal Next.js app router fixture (recommended).**
    - Pros: streaming, RSC and router in one; the most common framework; the
      framework hints already cover Next.js 14 to 16.
    - Cons: a large dependency tree for a fixture; needs a pinned install
      like the Vite one.
  - **A tiny hand-written streaming server.**
    - Pros: no dependencies; exact control of chunking.
    - Cons: does not catch real framework assumptions (absolute URLs,
      `Host` handling).

### 6. Performance thresholds and missing metrics

**Problem.** No thresholds exist, so no cohort can pass, and several things the
thresholds name are not measured.

**Context.** The Qualification bullet lists first byte, connect, HMR delivery,
peak queue and decode bytes, socket counts.

**Investigation.** Before 2026-11-03 `PreviewHistogramName` was only
`http.connect_ms`, `http.first_byte_ms` and `tunnel.open_ms`
(`apps/backend/src/preview-metrics.ts`), the desktop ingress
(`apps/desktop/electron/preview-transport-manager.ts`,
`preview-tunnel-client.ts`) recorded no metrics, and there was no
HMR-delivery or reconnect series anywhere. Re-checked against `main` at
`7b48c23fb`: still true. The metric additions are now in (D15): desktop
windows report `desktop.connect_ms`, `desktop.first_byte_ms`,
`desktop.reconnect{category}` and `desktop.reconnect_failed{category}` to
their backend, where they appear in `get_preview_diagnostics`. HMR delivery
is measured by `scripts/preview-latency-baseline.ts`, not the product.
Thresholds remain blocked on the two-machine baseline (7568: 0042 task 1)
and on the maintainer's approval of the pass rule (7568: 0042 task 6; D8
proposes p95 first byte and connect within 1.5x the direct route over the
same link, no unbounded queue growth and zero cross-service reach). Adding the
counters exposed a reattach race, filed as
3270 and fixed on 2026-11-03.

**Decisions.**

- **Add the missing series before the two-machine run?**
  - **Yes: reconnect counts and desktop-ingress connect and first byte; HMR
    delivery measured by the latency script, not the product (recommended).**
    - Pros: the run then yields every number thresholds need; the product
      gains only content-free counters.
    - Cons: new code and tests before a run that is already blocked.
  - **Measure everything from the client script only.**
    - Pros: no product change.
    - Cons: no production telemetry for the observation window in task 7.

### 7. Flip defaults and cohort sign-off

**Problem.** Tunnel and relay stay off by default; users get the legacy route
and its shared origin, cookie rewriting and missing WebSockets.

**Context.** "Enabling defaults" and D8. "An absence of
complaints is not a metric." Every flip keeps the rollback drill passing
(`apps/backend/tests/gateway-preview.test.ts:209`).
Security finding M1 (`docs/reports/2-26-10-27-security.md`) also asks for
this flip. Its first half shipped separately: every legacy
`browser/loopback` response now carries `Content-Security-Policy: sandbox`,
so the legacy route no longer runs preview HTML on the gateway origin and
this flip is no longer the only fix for M1.

**Investigation.** `DEFAULT_PREVIEW_SETTINGS` has `transport: true`,
`relay: true` since 2026-11-04
(`apps/backend/src/core/storage-preview-services.ts`).
`ORKESTRATOR_PREVIEW_TRANSPORT` and `ORKESTRATOR_PREVIEW_RELAY` remain the
overrides. The maintainer chose both decisions below on 2026-11-04 (D19): flip
right after, not after a cohort, and sign-off by the maintainer.

**Decisions.**

- **What observation window?**
  - **Opt-in cohort (maintainer and testers with the setting on) for one
    Stable release, judged by `PreviewMetrics` error and resource counts
    (recommended).**
    - Pros: real use with a rollback; matches the release cadence that the
      support window already uses.
    - Cons: a small cohort may miss rare network setups.
  - **Flip right after the two-machine run.**
    - Pros: fastest.
    - Cons: no field data before every desktop switches transport.
- **Who signs off?**
  - **The maintainer, recorded in the evidence log (recommended).**
    - Pros: the D8 recommendation; one accountable person.
    - Cons: single point of delay.
  - **Automatic once thresholds pass.**
    - Pros: no human bottleneck.
    - Cons: thresholds are not yet trusted enough to ship a default unattended.

### 8. Retire the legacy route and compatibility mode

**Problem.** The legacy loopback route breaks `__Host-` cookies, strips CSP,
has no WebSocket support and shares one origin across apps. It must stay until
old clients and stored legacy tabs are past the support window.

**Context.** D8. The register row in
`docs/architecture/version-compatibility.md:117` sets the removal condition:
the default has flipped, the floor is at or above the first Stable with that
default, and stored legacy tabs have a migration.

**Investigation.** Still present: `GatewayProxy.proxyToTarget`
(`apps/backend/src/gateway-proxy.ts:121`, counting
`preview.legacy-loopback-route` at `:133`; the name is registered in
`apps/backend/src/core/compatibility-path-usage.ts:37`), rewrite helpers across
`gateway-proxy.ts`, `gateway-support-extra.ts` and `gateway-auth.ts`, and
`ServiceBrowserTab` compatibility mode
(`apps/web/src/components/browser/ServiceBrowserTab.tsx:259-262`). **Open as
service** (`legacyUrlServiceMatch`,
`apps/web/src/lib/preview-service-entry.ts:116`) decides every conversion. Since
2026-11-04 a desktop with the tunnel available converts a matching tab when it
becomes active (D21), so only the `localhost` tabs have no migration, and the
register's condition now turns on them and the support window. Whether
compatibility mode stays as a labelled fallback after the flip and whether
annotations on legacy URL tabs retire with the route are the maintainer's
calls (D8 records the recommendation); they moved to the manual-test
checklist (7568).

**Decisions.**

- **How do stored legacy URL tabs migrate?** Chose automatic (2026-11-04, D21);
  plain URL tabs opening externally waits for the route's removal.
  - **Convert automatically where `legacyUrlServiceMatch` finds exactly one
    match; leave the rest as plain URL tabs that open externally
    (recommended).**
    - Pros: reuses the strict D4 rule; no guessing.
    - Cons: ambiguous tabs lose in-app preview.
  - **Only the manual Open as service.**
    - Pros: no surprise changes.
    - Cons: the register's "stored legacy tabs have a migration" is never
      met.

### 9. Shared legacy partition retention

**Problem.** Shared per-window legacy partitions of live connections are never
cleared and are the larger share of disk (93 MB in one profile).

**Context.** Code item 4's remainder: set a retention window once legacy URL
tabs are retired, and clean only partitions this install created.

**Investigation.** `PreviewPartitionRetention`
(`apps/desktop/electron/preview-partition-retention.ts`, node methods at
`:228`, `:257`, `:315`) handles service and node partitions only.
`browserPreviewPartitionForWindow` is unchanged. Readings so far
(`mise run disk:report` since D7, or a read-only `du`): 16 shared legacy
partitions, 93 MB, on the maintainer's macOS profile (2026-10-22), and one
shared partition, 172 kB, on another production profile. A reading from a
long-lived profile with many services is in the manual-test checklist
(7568: 0042 task 12).

**Decisions.**

- **Wait for task 8 or act now?**
  - **Wait, as the file says (recommended).**
    - Pros: clearing a live shared partition would log users out of every
      legacy tab.
    - Cons: disk keeps growing until then.
  - **Clear caches only (GPU, Code Cache) now, keep cookies and storage.**
    - Pros: recovers most of the measured bytes without logging anyone out.
    - Cons: new partial-clear code and tests; a new todo file under the
      README rules.

### 10. Real-window leftovers

**Problem.** Three fixes are proved at unit level only: another client's
`save_pane_layout` reaching an Electron window (item 9), node retention
against a real command node, and the narrow toolbar layout (item 11).

**Context.** Item 9's 2026-10-21 miss did not reproduce in unit tests.

**Investigation.** Item 9's guards are in `pane-layout-persistence.ts` and
`store-resource-sync.ts`; navigation basis is in
`apps/desktop/electron/ipc.ts:436-445`; the toolbar classes are at
`apps/web/src/components/browser/browser-tab-hooks.ts:21-23`. The Electron
spec has no case for any of the three.

**Decisions.**

- **Add Electron spec cases or check by hand?**
  - **Add two cases to `service-preview-electron.spec.ts`: a second client's
    layout save reaching the window, and the toolbar's address width at a
    519 px pane (recommended).**
    - Pros: permanent; the spec already has a second-backend fixture and
      narrow-window cases.
    - Cons: more time in an already 17-test spec.
  - **One manual pass, recorded in the evidence log.**
    - Pros: quick.
    - Cons: no regression coverage.
- **Node retention against a real command node?**
  - **Leave it at unit level (recommended).**
    - Pros: ten unit tests cover the voucher logic; a real multi-node setup
      costs a two-machine session.
    - Cons: the 30-minute registry read path is not seen end to end.
  - **Add it to task 1's session.**
    - Pros: real evidence for little extra time.
    - Cons: lengthens an already long run.

**Outcome (2026-11-06, `main` at `ee2cc8423`).** Both recommended directions
taken. `service-preview-electron.spec.ts` has two new cases:

- `at a 519 px pane the address takes its own full-width row in service and
  URL tabs`: the window at its 800×600 minimum and 100 % zoom gives a pane of
  exactly 519 CSS px. In a service tab and a legacy URL tab the address form
  sits below the button row and spans the toolbar's 503 px content width;
  the input is 369.7 px (service) and 365.3 px (URL), against 92 px before
  code item 11. The case holds the input to at least two thirds of the row
  rather than a pixel count (D26).
- `another client's layout save reaches the open window, also while its
  environment is not shown`: a second client on the window's own backend
  (the gateway over HTTP, D25) adds a third service tab while the
  environment is shown, then reorders the tabs and drops that one while no
  environment is selected. The window adopted both revisions without a
  reload, showed the reordered strip on return, and wrote nothing back.

The 2026-10-21 miss did not reproduce, so code item 9 is closed as verified.
Node retention stays at unit level (D27). Runs are in the evidence log.

### 11. Preview flakes 0620 and 0622

**Problem.** Two Electron preview flakes stay open and can fail
`mise run test:agent:electron`.

**Context.** Item 12 keeps 0620 open "for one more loaded window"; item 13
asks for Electron output if 0622 recurs.

**Investigation.** Both are still `open` in
`docs/tests/flaky-tests/previews-annotations-and-gateway/0000-index.md:29-30`.
Both index rows record recurrences in later main-merge runs, where the
complete owner then passed alone. Throttling switches are in `ELECTRON_TEST_SWITCHES`
(`e2e/agent-testing/electron-launch-switches.ts:29`).

**Decisions.**

- **How to close them?**
  - **Capture Electron main output on failure for 0622, and replace 0620's
    focus waits with a check that the picker received the key event
    (recommended).**
    - Pros: targets the stated missing evidence; keeps the tests strict.
    - Cons: test-harness work for flakes that pass on rerun.
  - **Keep observing.**
    - Pros: no work.
    - Cons: both already recurred; observation alone has not closed them.

**Outcome (2026-11-01, `main` at `93b99bfba`).** Both took the recommended
direction. Spec timing explains 0620 and the 0622 baseline-count race; the
original 0622 window-close symptom remains unexplained and open. Neither
recurred naturally on Linux; forcing the suspected timing reproduced the
keyboard and baseline-count symptoms. 0620: Radix moves menu focus in a
timer, and the spec read focus and pressed again before a late move landed. Each key now waits
for a page-side marker queued behind that move (D9). The Linux host-reachability
dialog, a second focus thief, is now off for the spec's backends (D11). 0622:
the multi-backend test counted an attachment still inside its 30-second
retirement lease. The test now waits for those leases before counting (D10).
The single 2026-10-21 window-close failure was not reproduced; its check now
reports the main process's release warnings. Runs are in the evidence log.

**Outcome (2026-11-06, `main` at `e6c3da899`).** The window-close symptom is
explained and fixed. A window's session outlives the window, so requests it is
still finishing reach the gateway request hook after `closed` released the
window's connection scope. `getRendererRequestAuthorization` threw there, and
main took an uncaught exception. On 2026-10-21 that meant Electron's default
blocking error box, which stops main before it releases the window's
attachments (read from the code of that date). Today it opens a sheet, and
headless Electron exits with SIGTRAP. CPU contention reproduced it in 5 of 10
runs. A released scope now gets no credential instead of an exception, and both
hooks always call back (D22). With the fix the same load passed 10 of 10, and
both flakes are resolved (D23). The audit of main's other webRequest listeners
(to-do 7060) is done: every listener now always answers
([renderer-security.md](../../architecture/renderer-security.md#webrequest-listeners)).

**Review validation repair (2026-11-06).** The review's `mise run
test:agent:electron` lost both service-preview specs in `beforeAll`, before any
test body: Chromium aborted the window's Vite modules with
`net::ERR_NETWORK_CHANGED` and the window stopped at "Orkestrator couldn’t
connect" (case
[2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md),
other builds' Docker work; the spec's own reachability probe was already off).
The launcher now reloads such a window, at most three times, only for that
failure (D24, `9ef37bfd1`). Afterwards, headless without a private network
namespace: the two owning tests 10 of 10 each, the owner without the
[to-do 7061, retired 2026-11-10](../../architecture/browser-previews.md#desktop-tunnel) case 21 of 21, the seeded
spec 6 of 6, and 10 separate cold launches 10 of 10. The other Electron specs'
first-title waits are
[7062](../cross-cutting/7062-electron-specs-recover-network-changed-startup.md).

Service previews shipped in #831 (`4f02156b`). Each previewed application gets
a backend-owned service identity, carried by a desktop tunnel, private HTTPS
origins or an optional container relay. The tunnel and relay default on since
2026-11-04; publication stays an opt-in. Real-stack evidence is single-machine only: Linux and Chromium
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
  `transport: true`, `relay: true` and `publication.enabled: false`. A backend
  with saved settings keeps them (D20).
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
  live connections are never cleared. A legacy URL tab converts to a service
  tab when the user chooses **Open as service** (2026-10-25) or, on a desktop
  with the tunnel available, by itself when it becomes active (2026-11-04).
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
  on a disposable agent-test profile: 24 tests since 2026-11-06, including a
  Vite application, a second window on a second, disposable standalone
  backend, a retention pass, Reset site data with a hostile worker and legacy
  URL tab history, the toolbar at a 519 px pane and another client's layout
  save. Agent-test backends keep that variable
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
6. After the support window and the maintainer's fallback call (task 8),
   remove compatibility mode from `ServiceBrowserTab` and retire the legacy
   route and its rewrite helpers, as a separate reviewed change.
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
   have recovered a missed update. Verified in a real Electron window
   2026-11-06 (task 10): another client's save reached the open window both
   while its environment was shown and while none was selected, with no
   reload and no write-back. The 2026-10-21 miss did not reproduce there
   either.
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
    a URL tab (was 92 and about 144). Measured in a real window 2026-11-06
    (task 10): 369.7 px and 365.3 px of a 503 px address row, which sits
    below the buttons in both tab kinds.
12. Done 2026-11-01: flake
    [0620](../../tests/flaky-tests/previews-annotations-and-gateway/0620-service-preview-keyboard-picker-register-item.md)
    is resolved. Delaying the renderer's zero-delay timers, as Chromium's
    throttling does, reproduced both recorded variants with the pre-change
    picker logic. The spec read focus before Radix's queued move landed and
    pressed again, so it either never reached **Register a service…** or
    overshot it before Enter. The 2026-10-21 focus wait helped only while
    timers ran within 2 seconds. `chooseFromPicker` now presses each key
    through `pressHandled`, which waits for a marker the page queues behind
    Radix's move (D9). On Linux hosts whose firewall drops Docker traffic, the
    startup host-reachability dialog also took focus mid-test, so the spec's
    backends now skip that probe (D11). The three throttling switches stay in
    `ELECTRON_TEST_SWITCHES`. Natural recurrence was not reproduced on Linux;
    a loaded macOS run with covered windows has not been repeated.
13. Done 2026-11-06: flake
    [0622](../../tests/flaky-tests/previews-annotations-and-gateway/0622-service-preview-window-close-remote-release.md)
    is resolved. The window-close symptom came from an uncaught exception in
    main: a closed window's last requests reached the gateway request hook
    after its scope was released, and `getRendererRequestAuthorization` threw
    (D22). Reproduced 5 of 10 under CPU contention; fixed in
    `ConnectionManager` and `installRemoteGatewayRequestAuth`, with unit tests,
    and 10 of 10 after. What follows is the 2026-11-01 state. The baseline-count
    race is fixed: the later failures (2026-10-24 twice and 2026-10-25) all failed
    the attachment-count poll right after the second window attached. The
    test's Local baseline still counted window 1's `svc-b` while its
    30-second retirement lease ran. A run slow enough to pass the lease saw
    the count fall by one. A 32-second hold after the baseline reproduced it
    exactly. The test now destroys window 1's tabs before starting the second
    backend and waits for its own `svc-a` to be the only Local attachment
    (D10). The single 2026-10-21 window-close failure was not reproduced and is
    not explained by the lease, since a closing window releases without one.
    That check now prints main's `[Previews]` lines (such as `Failed to
    release preview attachment.`) on failure. Those diagnostics stay; the 2026-11-06
    fix above closes the window-close symptom.

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
  only; the two-machine run (manual-test checklist, 7568: 0042 task 1) is
  still needed for remote backends over a real network.
- Firefox, Safari and iOS, top-level. Firefox passed bootstrap, sibling
  isolation, the `fixture.v1` subprotocol, revocation and hostile-worker
  checks on 2026-10-23 (throwaway certificate bypass; deployment trust remains
  open). WebKit passed the same engine checks. Shipping Safari with real
  certificate trust and the iOS handoff (`create_preview_handoff_url`,
  contract-tested only in `tests/unit/ios-mobile-contracts.test.ts`) are in
  the manual-test checklist (7568: 0042 task 3). Embedded surfaces are in [0046-embedded-service-previews.md](0046-embedded-service-previews.md).
- Docker Desktop on macOS and Windows: resolver binding inspection, Auto host
  ports, recreation onto a reused port, and the `docker exec` relay. On
  2026-10-17 the opt-in Docker suite passed on Docker Desktop 4.93.0 for macOS
  (binding inspection, a same-port host decoy, recreation onto a reused port
  and the exec relay). That run used Docker-assigned host ports, not
  Orkestrator's Auto mapping (`hostPort: 0`). On 2026-10-22 an Auto mapping
  passed on Docker Desktop 4.88.1 for macOS (published with the backend's own
  `publishedPortArguments`, seeded, resolved from Docker's binding and
  followed through recreation). Windows is out of scope (D18).
- Hostile service worker. Real Chromium on private origins passed on
  2026-10-22 (see the evidence log): re-sign-in is blocked until site data is
  cleared, the worker never sees a grant, its captured session code is
  refused by other hosts, and no control authority is reached. It did reach a
  sibling service with a credentialed read, which contradicted "no other
  service is ever reached"; since 2026-10-23 the backend refuses that read
  and the spec asserts nothing reaches the sibling
  (to-do 0054, retired 2026-11-10; the read policy is in
  [browser-previews.md](../../architecture/browser-previews.md#private-https-origins)).
  The same worker checks passed in Firefox and Playwright WebKit on
  2026-10-23. Electron's **Reset site data** with the hostile and benign
  workers installed on a desktop-tunnel service passed on 2026-10-25 (see the
  evidence log). Shipping Safari is in the manual-test checklist (7568:
  0042 task 3).
- Compatibility cases. Passed in Playwright Chromium, Firefox and WebKit on
  2026-10-25 (see the evidence log): SPA deep links and history, the `srcset`
  route, source maps, IndexedDB, BroadcastChannel, service-worker and Cache
  isolation between siblings, frame denial of bootstrap, session and refusal
  pages and the web client's no-opener popup, and an IPv6-only (`::1`)
  target. The Next.js 16.4.3 app-router fixture passed in Chromium and
  Firefox on 2026-11-03 (see the evidence log; WebKit not run on beelink,
  2680). Real-provider OAuth compatibility is deferred (D13; synthetic
  external redirects into a same-service frame and top-level return are
  covered since 2026-10-23) and in the manual-test checklist (7568: 0042
  task 5).
- Performance thresholds. Set them from the two-machine baseline (first byte,
  connect time, HMR delivery, peak queue and decode bytes, socket counts)
  before any cohort counts as passing. Not set: no two-machine baseline
  exists. `PreviewMetrics` (`apps/backend/src/preview-metrics.ts`) has
  `http.connect_ms`, `http.first_byte_ms` (declared but never recorded until
  2026-10-22; now recorded per private-origin request) and `tunnel.open_ms`
  histograms. Since 2026-11-03 desktop windows also report their ingress
  `desktop.connect_ms` and `desktop.first_byte_ms` series and
  `desktop.reconnect{category}` / `desktop.reconnect_failed{category}`
  counts into the same diagnostics (task 6, D15). HMR delivery stays a
  client-side measurement: `scripts/preview-latency-baseline.ts` measures
  it, with connect and first byte per route.

### Enabling defaults

- Desktop tunnel: on by default since 2026-11-04, on the maintainer's sign-off
  and ahead of the criteria this file set: the two-machine run has not passed
  and no observation window or threshold is recorded (D19). The real-Electron
  cases passed on 2026-10-21. An absence of complaints is not a metric, so this
  flip has no field evidence behind it yet.
- Publication cannot be a default: it needs an operator-provided domain,
  certificate, key and listen address. It stays a per-deployment opt-in, gated
  by the DNS and certificate run for that deployment type.
- Relay: on by default since 2026-11-04. Docker Desktop for macOS and Linux
  Engine passed, Windows is out of scope (D18), and the image requirements
  (`node` or `bun`, and the `node` user) are in `browser-previews.md`.
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
    reads not checked). Recorded as to-do 0054 (retired 2026-11-10);
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
  decisions in to-do 0054, retired 2026-11-10; the policy is in
  [browser-previews.md](../../architecture/browser-previews.md#private-https-origins)).
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
  to-do 0054 (retired 2026-11-10). Shipping Safari/iOS, private
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
  failures: [9863](../../tests/flaky-tests/electron-and-desktop/9863-electron-nickname-reload-timeout.md)
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

2026-11-01, preview flakes 0620 and 0622 (task 11), branch
`preview-flakes-d5abda30c5f5-r1` from `main` at `93b99bfba`. Linux 7.1.8
(x86_64, Arch, beelink), Bun 1.4.4, Electron 45.0.0, Playwright 1.64.0, one
worker, with other builds running on the host; durations are not reference
figures. `ORKESTRATOR_PREVIEW_TRANSPORT=1` as the spec sets it. No run used
the desktop session: Electron used a private Xvfb display (the Arch
`xorg-server-xvfb` 21.1.25-2 binary extracted to a temporary directory, not
installed) with the Wayland and session-bus variables removed (from the third
run, the compositor and scale variables too). From the fifth run onwards it
also ran inside a private loopback-only network namespace
(`unshare --user --net`, `lo` up, then `unshare --user --map-user` back to the
same uid). The command was
`bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts
service-preview-electron.spec.ts --workers=1`, with `--repeat-each` and `-g`
for single tests.

- Host conditions found first: two of the first four starts failed with
  `net::ERR_NETWORK_CHANGED` while loading the renderer. Docker networks from
  other builds, and the spec's own reachability probe, change the host's
  interfaces, and Chromium aborts loads in flight when that happens; the
  private network namespace removed this. On this host ufw drops Docker
  traffic, so the startup reachability dialog covered the window (D11).
- 0622, reproduced: a temporary hold of 32 seconds after the Local baseline
  (2) read 2 until about 30 seconds, then 1, and the next poll failed with
  `Expected: 3, Received: 2`. With the fix and the same hold: 1 throughout,
  passed.
- 0620, natural: the 2026-10-21 logic passed 5 of 5 and the pre-change logic
  3 of 3, both on two pinned cores. Forced (renderer zero-delay timers delayed
  while the picker is open): the pre-change logic failed at 60 ms (the dialog
  missing after **Register a service…**, and in another run the dialog opening
  in place of the switch to `svc-b`) and at 1 second (every read stale). The
  reachability dialog took focus in four forced runs before the switch, which
  were repeated after it.
  The 2026-10-21 logic passed at 60 ms, 1 second and 2.5 seconds, but at 2.5
  seconds it pressed again while a move was queued. The new logic passed at
  60 ms, 1 second and 2 seconds.
- After both fixes: the keyboard test passed 5 of 5, and 5 of 5 on two pinned
  cores. The multi-backend test, run with the two tests before it, passed 3
  of 3, and 2 of 2 on two pinned cores. The first complete owner passed 18 of
  18. The second passed both owning tests but failed
  `a remote terminal link opens the native localhost forward in a separate
  browser`, recorded and fixed as
  [2390](../../tests/flaky-tests/previews-annotations-and-gateway/2390-remote-terminal-link-hover-new-window.md).
  Unchanged, it failed 4 of 4 alone; fixed, it passed 5 of 5, and 3 of 3 on
  two pinned cores. With every change in, the complete owner passed 18 of 18
  twice more.
- `apps/desktop/tests/backend-process.test.ts` (56, including the new
  allowlist assertion) passed from `apps/desktop` with its package preload;
  `tests/unit/flaky-tests-index.test.ts` passed; `bun check -p
  e2e/agent-testing/tsconfig.json`, `oxlint` and `bun fmt --check` on the
  changed files passed.
- Not run: macOS (the platform of every recorded 0620 failure), a full
  `mise run test:agent:electron` suite, and the window-close failure of
  2026-10-21 under its original load.
- Cleanup: every run's temporary profile root was removed by the spec, and no
  Electron, backend or Vite process of these runs is left. The private Xvfb,
  its extracted binary, the wrapper scripts and the timer-delay and hold
  hooks (never committed) are removed. The runs before the switch removed
  their own probe containers and networks; the three probe networks created
  on the host later that morning belong to other builds' owners and were left
  alone. Evidence: `output/agent-testing/d5ab-*` in the worktree.

2026-11-03, the Next.js app-router fixture (task 5), working tree based on
`7b48c23fb`, beelink (Arch Linux, Linux 7.1.8, x86_64), about ten other builds
running.

| Item | Version |
| --- | --- |
| Bun / Node (mise) | 1.4.4 / 26.7.0 |
| Next.js fixture | 16.4.3 (Turbopack dev server), React and React DOM 19.3.1, isolated copy at `/tmp/preview-next-hgEXO8` installed with `bun install` |
| Browsers | Playwright Chromium and Firefox, headless |

- Opt-in variable: `ORKESTRATOR_TEST_PREVIEW_NEXT_DIR` (the spec hands it to
  the harness as `ORKESTRATOR_TEST_PREVIEW_HARNESS_NEXT_DIR`, so other preview
  specs do not start Next.js). The harness registers `next dev` on its own
  port, with no counting relay, and runs it under Node in its own process
  group.
- `ORKESTRATOR_TEST_PREVIEW_NEXT_DIR=/tmp/preview-next-hgEXO8 mise run
  test:logged -- --name preview-next-chromium -- bunx playwright test --config
  e2e/preview/playwright.preview.config.ts next-app-router --project
  chromium`: before the `mapLocation` change 4 passed, 1 failed, 1 did not
  run. The absolute redirect from `/go` went to
  `https://localhost:<appPort>/items/7` and failed with
  `net::ERR_SSL_PROTOCOL_ERROR`. After it: 6 passed. The same command with
  `--project firefox`: 6 passed.
- `--project webkit`: every case failed at browser launch with the missing
  `libicu74`, `libxml2` and `libflite1` of
  2680.
  The private `PLAYWRIGHT_BROWSERS_PATH` workaround was not set up for this run.
- The whole preview suite with the Next.js variable set, `bunx playwright
  test --config e2e/preview/playwright.preview.config.ts --project chromium
  --project firefox`: 48 passed, 4 skipped (the Vite cases, no Vite fixture
  installed).
- `packages/protocol/src/node/preview-forward.test.ts` (new case for
  forwarded-scheme redirects) passed.
- Covered through the private origin: a document whose Suspense boundary
  resolves 1.5 s later arrives in at least two reads at least 750 ms apart
  (not buffered); hydration; `Link` navigation to `/items/42` and back
  without a document load; a deep link to `/items/7`; a Server Action through
  `useActionState` (mapped `Origin`, no `allowedOrigins`); a route handler
  sees `Host: localhost:<port>`, the public `X-Forwarded-Host` and
  `X-Forwarded-Proto: https`; the `/go` absolute redirect lands on the public
  origin; editing `app/hmr-label.js` updates the page by Fast Refresh with the
  counter state and a window marker kept.
- Not run: the legacy `/__orkestrator/browser/loopback/<port>/` route (Next.js
  serves `/_next/` from the root, so it needs a `basePath` it does not have),
  the desktop tunnel and relay transports, Electron, WebKit, real OAuth.
- Cleanup: each harness stopped its `next dev` process group on shutdown and
  the spec restored `app/hmr-label.js`. Next.js's detached telemetry flush
  helper (a no-op with telemetry disabled) exits by itself. No container,
  profile or Docker network was created.

2026-11-04, seeded restart inside the verification window
(3230), branch
`verification-restart-process-1dad5f1b3e75-r1` based on `96ee1eb3e`; macOS
27.0 arm64, Bun 1.4.4. Disposable agent-test profile under a temporary root
with `ORKESTRATOR_PREVIEW_TRANSPORT=1`, as the spec sets it; no other opt-in
variables. Command, once per run:
`bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-seeded-electron.spec.ts`.

| Run | Backend | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| 1 to 4 | with the fix | 6 | 0 | 0 |
| 5, on commit `b666f15fc` | with the fix | 1 | 1 (check 2, before any restart: flake [4470](../../tests/flaky-tests/previews-annotations-and-gateway/4470-seeded-preview-moved-port-link-not-printed.md)) | 4 (serial, after the failure) |
| 6 to 10, on commit `b666f15fc` | with the fix | 6 | 0 | 0 |
| Control | in-window recheck temporarily disabled | 3 | 1 (check 6: generation unchanged) | 2 (serial, after the failure) |

No dev server process was left running after the runs. The spec removes its
temporary root in `afterAll`; its private temporary directory was not inspected
separately.

2026-11-06, task 10 Electron cases, branch
`electron-spec-cases-39d169043933-r1` from `main` at `ee2cc8423`. macOS 27.2
arm64, Bun 1.4.4, Electron 45.0.0, Playwright 1.64.0. The spec's own
disposable agent-test profile under a private temporary root, with
`ORKESTRATOR_PREVIEW_TRANSPORT=1` and `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`
as the launcher sets them; no shell was attached, so Electron ran with hidden
windows. No provider turn, login or container. Commands, each through
`mise run test:logged` with `ORKESTRATOR_AGENT_TEST_RUN_ID` set to the run's
name:

| Run | Command (after `bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/service-preview-electron.spec.ts`) | Passed | Failed | Not run |
| --- | --- | --- | --- | --- |
| `svc0042-task10-new` | `--grep "519 px pane\|another client's layout save"` | 2 | 0 | 0 |
| `svc0042-task10-owner` | none (complete owner) | 16 | 1 (legacy URL tab Back, [to-do 7061, retired 2026-11-10](../../architecture/browser-previews.md#desktop-tunnel)) | 7 (serial, after the failure) |
| `svc0042-task10-without` | `--grep-invert` the two new cases | 15 | 1 (the same case and message) | 6 |
| `svc0042-task10-owner2` | `--grep-invert "keeps a link and Back through routine"` | 23 | 0 | 0 |

- The new cases passed on their own (12.1 s with startup) and inside the
  complete owner (338 s for 23 cases), so they neither depend on earlier
  cases nor disturb the ones after them.
- Toolbar at a 519 px pane: the window's minimum size needed no widening
  (`shortfall` 0). Service tab: pane 519, toolbar content 503, address form
  503 wide at y 161 below the buttons (y 123 to 155), input 369.7. URL tab:
  the same row, input 365.3. The rest of the row is the route chip (service
  label or "Backend") and **Go**. Screenshots:
  `output/visual-previews/toolbar-519-service.png` and `toolbar-519-url.png`.
- Cross-client layout save (a `BackendHttpClient` on the profile's gateway
  with its token, never printed): the window adopted the added tab at
  revision 34, and the reorder made while no environment was selected at
  revision 35, before it was selected again; the strip then read `svc-b 1`,
  `svc-a 2`. A marker set in the renderer survived, so no reload was
  involved, and 1.5 s later the stored revision was still 35. In the
  two-case run the revisions were 4 and 5.
- The legacy URL tab Back case failed at `:2335` with the address left on
  `/app/next`, with or without the new cases: to-do 7061's symptom, here on
  macOS hidden windows rather than Linux headless. It is not caused by this
  change.
- Cleanup: the spec stopped Electron, its backend, the second backend and
  every fixture, and removed its temporary root; no Electron or backend
  process from these runs was left. Evidence:
  `output/agent-testing/svc0042-task10*`.

2026-11-06, task 10 review repairs after `ae2e5f305`:

- The cross-client case now uses the exact `save_pane_layout` response revision,
  with no later read substituting for it. It checks that revision after shown
  adoption, after hidden adoption before reselecting, and after returning to the
  environment. The first assertion runs before the next remote save, so a
  renderer echo cannot be absorbed into that save's initial revision read.
- Moved the case beside the narrow-toolbar case, before the legacy Back case,
  so the known serial failure cannot prevent it from running.
- Fixed the recorded legacy Back failure as well: its synthetic re-attach now
  carries the renderer's environment identity. Omitting it replaced the view
  and discarded its history. All original navigation assertions remain;
  [to-do 7061, retired 2026-11-10](../../architecture/browser-previews.md#desktop-tunnel) records the diagnosis.
- Targeted Electron command, through `test:logged`, run ID
  `svc0042-review-fixed`: `bunx playwright test --config
  e2e/agent-testing/playwright.electron.config.ts
  e2e/agent-testing/service-preview-electron.spec.ts --grep "another client's
  layout save|keeps a link and Back through routine"`: **2 passed**, 29.5 s.
- Mutation evidence: temporarily injected an identical save through the
  renderer's invoke after remote adoption and before the settled read. The
  shown probe (`ORKESTRATOR_REVIEW_ECHO_PROBE=1`, run ID
  `svc0042-review-echo-shown`) failed the exact revision check, expected 2,
  received 3; the hidden probe (`=2`, `svc0042-review-echo-hidden`) failed the
  same check, expected 3, received 4. Both used the same focused Playwright
  command with `--grep "another client's layout save"`. The injected code was
  removed before the full suite. Logged failure evidence:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.1ldPE9/preview-echo-shown.log.gz`
  and `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.zvwhoc/preview-echo-hidden.log.gz`.
- Focused static checks passed: `bun check -p e2e/tsconfig.json` (through
  `test:logged`), `bunx oxlint e2e/agent-testing/service-preview-electron.spec.ts`,
  and `bun fmt --check e2e/agent-testing/service-preview-electron.spec.ts`.
  Passing preparation-wide lint and typecheck were retained without repetition.
- Exact recorded command rerun (through `test:logged --name review-electron`),
  `mise run test:agent:electron`, run ID `svc0042-review-electron`: **61 passed,
  4 failed, 5 skipped, 5 not run**, exit 1, 594.2 s. The complete changed
  service-preview spec passed **24/24**; cross-client ran before legacy Back,
  adopted revisions 29 and 30 and settled at 30. The legacy Back case kept
  the expected five `/` traces and passed the ordered stale Back/link checks.
- Remaining validation limits: gateway transport still closed its first window;
  terminal Resume still missed Vim's empty-editor ruler; workspace realm still
  sampled only two x positions. Preparation's `failureTriage` marks all three
  `undetermined` (`not-import-traceable`, with `known-flaky` context for the
  latter two). They drive untouched specs and no production code changes in
  this branch explain them; they remain for the verifier, not excused as
  pre-existing. A new failure in the untouched seeded-preview spec's
  `beforeAll` reported `No two adjacent free loopback ports` and left its next
  five cases not run; its cause is also unqualified here.
- Rerun artifacts: `output/agent-testing/svc0042-review-electron/electron/results.json`
  and `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.FmCip9/review-electron.log.gz`.
  The original review package and its output artifacts were not changed.
  The rerun JSON has no errors outside test cases. No live service-preview
  worker or temporary service-preview profile root remained after cleanup.

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

2026-11-04, default flip and legacy tab migration (tasks 4, 7 and 8), branch
`build-delete-file-5d96944a6cd8-r1` based on `4e3caa079`, Linux, one machine.

- Two machines: not run. `tailscale ping mbp3` answered in 5 ms over a direct
  path, but SSH to it was refused on port 22 on every attempt, so nothing ran on
  a second machine and no baseline or threshold exists from this work.
- Observed in a fresh agent-test profile (`dev:test --fixture --headless-electron`):
  **Issue new preview access** and **Container relay** are both on, Desktop tunnel
  and Container relay show Available, and both switches turn off.
- Real Electron, headless on Linux (`ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1
  bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts
  e2e/agent-testing/service-preview-electron.spec.ts --grep <case>`): the tunnel
  case and the new stored-tab migration case passed, the migration case both alone
  and after the tunnel case. The complete spec was not run.
- `a legacy URL tab keeps a link and Back through routine re-attaches` failed 4 of
  4 headless, at the stale-attach step (address stays `/app/next`, expected `/`).
  It also failed 2 of 2 with this change's product code reversed, so this change
  did not cause it. It was not run on a real display, because that would open
  windows on the host's desktop, so whether it is specific to headless or already
  broken on `main` is unknown. It is deterministic here, so it is not recorded as a
  flake.
- `mise run test` failed on one test of more than 32,000:
  [4041](../../tests/flaky-tests/backend-services-and-tooling/4041-toolchain-stamp-same-millisecond.md),
  in a package this change does not touch. Workspace counts: backend 14032, web
  11801, protocol 4498, desktop 1674, CLI 458, web-public 41, toolchain 123 pass
  with 1 fail; root and bridges groups passed. `mise run format:check`, `mise run
  lint` and `mise run typecheck` passed.
- Not run: `test:preview:browser`, `test:preview:docker`, `test:browser`, a real
  container through the default-on relay, and anything on macOS. Profiles were
  stopped and reset.

2026-11-06, the 0622 window-close symptom (task 11), branch
`preview-flakes-1bb27c3be3fd-r1` from `main` at `e6c3da899`, fix `03cbf0191`.
Linux 7.1.8 (x86_64, Arch, beelink, 16 logical CPUs), Bun 1.4.4, Electron
45.0.0, Playwright 1.64.0, one worker, other builds running on the host (load
average 9 to 24); durations are not reference figures. Electron ran headless
(`ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`, which strips the display
variables), so no window reached the desktop. The command was
`bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts
service-preview-electron.spec.ts --workers=1`, with `-g` and `--repeat-each`
as below.

- Host first: without a private network namespace, 3 of 10 runs of each owning
  test failed at startup with `net::ERR_NETWORK_CHANGED` on Vite modules (the
  title never appeared), which is
  [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md).
  Every run below used a private loopback-only namespace
  (`unshare --user --map-root-user --net`, `lo` up, then `unshare --user
  --map-user` back to the same uid).
- Before the fix: the keyboard test passed 10 of 10 and the multi-backend test
  10 of 10 (windows gone 105 to 119 ms after `close()`).
- Forced slow close (temporary, not committed): a 25-second `beforeunload`
  busy-wait in window 2. The pre-2026-10-21 step failed with `Expected: 0,
  Received: 1` after 20 seconds with the window still open; the current step
  passed, `closedAfterMs` 25939 and the release 380 ms later.
- Under CPU contention (every process of the run pinned to two cores with
  `taskset -c 0,1`, beside four busy loops on those cores, all started and
  stopped by one script by PID): the multi-backend test failed 5 of 10. Each
  failure was `[desktop] uncaught-exception ... The requesting window is no
  longer available.` from `getRendererRequestAuthorization` in the window's
  gateway request hook, then the uncaught-exception sheet and Electron exiting
  with SIGTRAP. A temporary probe named the requests: Vite renderer modules
  whose headers arrived 8 ms after the window's `closed`.
- After the fix: under the same contention the multi-backend test passed 10
  of 10 with no `uncaught-exception` line (closed 41 to 1896 ms after
  `close()`, released 24 to 449 ms after that). On the committed code, without
  contention: the keyboard test 10 of 10, the multi-backend test 10 of 10.
  The keyboard test under the same contention: 10 of 10.
- Complete owner, committed code: 3 runs each failed `a legacy URL tab keeps a
  link and Back through routine re-attaches` (address stays `/app/next`, the
  2026-11-04 headless failure above), and serial mode then skipped the 6 cases
  after it; the 15 cases before it passed each time. Without that case
  (`--grep-invert`), the other 21 passed twice in a row (42 of 42), the
  multi-backend case included (released 389 and 165 ms after the window was
  gone). The headless failure is now
  [to-do 7061, retired 2026-11-10](../../architecture/browser-previews.md#desktop-tunnel).
- `apps/desktop` tests: `connection-manager.test.ts`,
  `remote-gateway-request-auth.test.ts`, `window-workspace-target.test.ts` and
  `connection-manager-federation.test.ts` passed (103); the two new 0622 cases
  failed with the source change reverted. `bun run --cwd apps/desktop
  typecheck`, `bun check -p e2e/agent-testing/tsconfig.json`, `oxlint` and
  `bun fmt --check` on the changed files, `tests/unit/flaky-tests-index.test.ts`,
  `tests/unit/todo-index.test.ts` and `mise run format:check` passed.
- Not run: macOS (the platform of the 2026-10-21 failure), a real display, and
  a full `mise run test:agent:electron` suite.
- Cleanup: every run's temporary profile root was removed by the spec; no
  Electron, backend, Vite or busy-loop process of these runs is left. No
  Docker resources were created. The probe, the slow-close hook and the run
  scripts were never committed.

2026-11-06, review validation repair (task 11, D24), branch
`preview-flakes-1bb27c3be3fd-r1` at `9ef37bfd1`. Same host and versions, one
worker, headless (`ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`,
`ORKESTRATOR_HOST_REACHABILITY_CHECK=off`), **without** a private network
namespace, other builds running (load average 10 to 35), 01:58 to 02:05 UTC.
Commands were `mise run test:logged -- --name <name> -- bunx playwright test
--config e2e/agent-testing/playwright.electron.config.ts <spec> --workers=1
--retries=0` with the options below; counts are from each run's
`results.json`.

- Keyboard picker test (0620), `--repeat-each=10`: 10 passed.
- Multi-backend test (0622), `--repeat-each=10`: 10 passed.
- Complete owner with `--grep-invert` for the 7061 case: 21 passed.
- `service-preview-seeded-electron.spec.ts`: 6 passed.
- `the tunnel is advertised and a service loads through its credentialed
  loopback ingress`, the case the review lost, in 10 separate invocations
  (10 cold launches): 10 passed.
- No run printed `[startup-recovery]`, so no startup needed a reload in this
  window. `e2e/agent-testing/electron-startup-recovery.test.ts` passed 12
  tests; `bun check -p e2e/agent-testing/tsconfig.json`, `oxlint` and
  `bun fmt` on the changed files passed.
- Not run: forced network churn (it would abort other builds' loads on this
  host; 7062 task 2), and a full `mise run test:agent:electron`.
- Cleanup: each spec removed its temporary profile root; no Electron,
  backend or Vite process of these runs is left. No Docker resources were
  created.

## Open questions

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

Recorded 2026-11-04 for tasks 4, 7 and 8, on branch
`build-delete-file-5d96944a6cd8-r1`.

- **D18. Windows (task 4).** Options: (a) keep the relay off until Windows passes,
  as the task recommended; (b) drop the gate. Chose (b): the maintainer said on
  2026-11-04 that only macOS and Linux are in use and Windows is not needed now.
  Cost: a future Windows desktop inherits a relay default no run has proved.
- **D19. Flip ahead of its evidence (task 7).** Options: (a) an opt-in cohort for
  one Stable release, which this file recommended; (b) flip now on the
  maintainer's sign-off. The maintainer chose (b) on 2026-11-04, and also asked
  for the two-machine run on mbp3, which could not start (see the evidence log).
  Pro: every desktop leaves the shared legacy origin sooner. Con: remote-backend
  previews have no real-network evidence and no thresholds, and there is no field
  data. Rollback is the settings switch or the overrides, and the rollback drill
  still passes.
- **D20. Saved settings on upgrade.** Options: (a) change only the default for
  backends with no saved row; (b) a one-time upgrade that turns saved rows on.
  Chose (a): a saved off is indistinguishable from a deliberate kill switch, and
  (b) would override it. Cost: an install that saved these settings with the
  switch off stays on the legacy route until someone turns it on.
- **D21. Where stored tabs migrate (task 8).** Options: (a) in the tab, when it
  becomes active on a desktop with the tunnel available; (b) in the backend over
  stored layouts; (c) in the tab on every client. Chose (a). (b) converts tabs
  against bindings nobody is looking at, and the strict match needs a live
  snapshot anyway. (c) gives a web client without publication a setup message in
  place of a working view. A failed or changed check leaves the tab and shows the
  existing message rather than retrying. Cost: `localhost` tabs do not match and
  stay URL tabs, and a migrated tab starts with an empty service partition, so an
  application it was signed in to asks again.

Recorded 2026-11-01 for task 11 (flakes 0620 and 0622), on branch
`preview-flakes-d5abda30c5f5-r1`.

- **D9. How the keyboard test waits for the picker (0620).** Options: (a)
  keep the 2026-10-21 wait (up to 2 seconds for focus to change, then assume
  the end of the menu) and keep observing; (b) a longer focus wait; (c) wait
  for proof that the page handled each key: a capture-phase keydown listener
  queues a timer that queues another, which runs after Radix's focus move.
  Chose (c), as the task analysis recommended. Pros: no time-based guess, so
  delayed timers cannot make a read stale or cause a second press; a key that
  never arrives fails as such, with the last keys and focus; no assertion
  timeout raised. Cons: it relies on Chromium running equal-delay timers in
  order (the HTML timer rules) and on Radix moving focus in one zero-delay
  timer (`@radix-ui/react-roving-focus` 1.2.1); a Radix change to that would
  show as a failure that names the key and focus. (a) passes at forced delays
  up to 2.5 seconds but already presses again while a move is queued; (b)
  only moves the threshold.
- **D10. How the multi-backend test counts Local attachments (0622).**
  Options: (a) shorten the retirement lease for agent-test runtimes; (b) count
  per service or per window, which `get_preview_diagnostics` does not expose;
  (c) wait until window 1's own `svc-a` is the only Local attachment before
  taking the baseline. Chose (c). Pros: spec-only; tests the product's real
  lease; the teardown now runs before the second backend starts, so its start
  overlaps the wait. Cons: the test waits up to the lease (about 30 seconds,
  less the backend's start) on every run; it now asserts that no earlier test
  leaves a Local service attached, which was already its stated assumption
  ("only this test's own views"). (a) would change what the other tests
  measure (the retention test relies on the 30-second lease); (b) needs new
  diagnostics in the product for a test.
- **D11. The Linux host-reachability dialog during the spec.** Options: (a)
  dismiss it with another startup-dialog handler; (b) turn the startup probe
  off for the spec's backends with the existing
  `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, which scenario and CLI test
  backends already use, adding it to `AGENT_TEST_SAFE_ENV_NAMES` so agent-test
  backends keep it. Chose (b). Pros: handlers run only before locator actions,
  so (a) cannot stop the dialog taking focus during key presses; (b) also
  stops each run creating a probe network for a profile that is deleted
  afterwards (the leak 0241 and 0730 closed for the CLI harnesses). Cons: the
  allowlist grows by one policy switch; other Electron specs still probe and
  can show the dialog on such hosts until they set it too.
- **D12. Absolute redirects built from the forwarded scheme** (task 5,
  2026-11-03). Next.js route handlers build `request.url` from
  `X-Forwarded-Proto` and their listening port, so a plain HTTP app behind an
  HTTPS preview redirects to `https://localhost:<appPort>/…`. Options: (a)
  leave `mapLocation` alone and record the gap; (b) stop sending
  `X-Forwarded-Proto: https`; (c) also map the private origins under the
  public origin's scheme on the same port. Chose (c)
  (`forwardedSchemeOrigins` in `preview-header-policy.ts`). Pros: only this
  application listens on that port, so the redirect is still same-service and
  now stays inside the preview; no request header changes. Cons: one more
  origin form to keep canonical (a default port is spelled out, so
  `https://localhost` is not taken for an app on port 80). (a) leaves a common
  Next.js pattern broken; (b) would break Secure-cookie decisions the
  2026-10-16 header work relies on.
- **D13. Real-provider OAuth** (task 5, 2026-11-03). Options: defer and rely
  on the synthetic redirect cases; one run against a provider's test tenant.
  Chose to defer. Pros: no provider credential in a test or on this shared
  host; the build's constraints exclude real logins. Cons: provider-specific
  redirect-URI checks stay untested. Revisit when a test tenant and a place to
  keep its credential exist.
- **D14. The Next.js fixture's shape** (task 5, 2026-11-03).
  - Version: Next.js 16.4.3 rather than the newest 16.4.4, published the day
    before the run; React 19.3.1. Pros: not a day-old release. Cons: one patch
    behind; bump it like the Vite pin.
  - Install pinning: exact direct versions and no lockfile, as the Vite
    fixture. Pros: no third standalone `bun.lock` for the drift test and the
    lockfile rules; Next.js pins its own runtime dependencies exactly apart
    from browser-data packages. Cons: those two packages float.
  - Plain JavaScript pages. Pros: `next dev` does not install TypeScript or
    write a `tsconfig.json` into the copy. Cons: none for the checks made.
  - No relay in front of `next dev`, unlike Vite. Pros: Next.js puts its own
    listening port in absolute URLs; behind a relay the redirect would name a
    port the preview does not know, testing the harness rather than the app.
    Cons: no upstream connection counts for Next.js.
  - Browsers: Chromium and Firefox; WebKit is blocked on beelink by 2680 and
    the spec has no engine-specific skip, so it runs wherever WebKit launches.

Recorded 2026-11-03 for task 6's metric additions, on branch
`preview-reconnect-metrics-ca90ec0df07b-r1`.

- **D15. How desktop ingress metrics reach the existing preview metrics
  (task 6).** Options: (a) Electron keeps its own `PreviewMetrics` and exposes
  it to the renderer over IPC; (b) Electron buffers the series and reports
  them to the window's own backend with a new command,
  `record_preview_client_metrics`, which folds them into `PreviewMetrics`;
  (c) measure everything from the latency script only. Chose (b). Pros: the
  series appear in `get_preview_diagnostics`, which the runbook's `watch`, the
  baseline JSON and task 7's observation window already read, with no new
  reader; each window reports to the backend whose tunnel it measured. Cons:
  a new command; samples lag by up to the 30-second report interval; a report
  that fails (an older backend without the command, a dropped connection) is
  dropped rather than retried. The command accepts only the four fixed names,
  safe failure categories, integer counts up to 100,000 and at most 512
  samples per series, each 0–600,000 ms, and rejects the whole report
  otherwise, so nothing free-form can reach diagnostics. (a) would leave the
  numbers invisible to the CLI and scripts; (c) gives no production telemetry
  for task 7.
- **D16. What counts as a reconnect (task 6).** Options: (a) every connection
  refused with `access-expired` or `generation-changed`; (b) every reattach
  actually started, from a refused connection or a refused renewal
  (`access-expired`, `generation-changed`, `not-found`). Chose (b), labelled
  by the category that forced it, with `desktop.reconnect_failed{category}`
  when the reattach fails. Pros: matches backend work (one
  `create_preview_attachment` each); connections that join an attach in
  flight do not inflate it. Since
  3270 (2026-11-03), one revocation
  starts one reattach, so it counts once.
- **D17. Where connect and first byte are measured (task 6).** Connect is
  `openPreviewTunnel` from the WebSocket connect to `OPEN_OK`
  (`PreviewTunnelStream.openMs`), for new upstream connections only (pooled
  reuse is not a connect), excluding any attach. First byte is the shared
  forwarder's `firstByteMs` (from the forwarder starting the request, tunnel
  connect included unless a pooled connection is reused, to the upstream
  response head) for the loopback ingress and the external-browser forward.
  Pros: first byte is the same field the backend's `http.first_byte_ms`
  records, and connect is the client-side view of what the backend's
  `tunnel.open_ms` measures from accept. Cons: an upgrade (WebSocket)
  contributes a connect sample but no first-byte sample.

Recorded 2026-11-06 for task 11 (the 0622 window-close symptom), on branch
`preview-flakes-1bb27c3be3fd-r1` from `main` at `e6c3da899`.

- **D22. Where a closed window's late requests stop throwing.** Options: (a)
  `getRendererRequestAuthorization` answers `null` for a released scope; (b)
  the gateway request hooks catch a throwing lookup and still call back; (c)
  keep the scope bound until the window's requests drain. Chose (a) and (b),
  as [6303](../cross-cutting/6303-window-close-during-request-throws.md)
  recommended (a). Pros: (a) covers every caller of the lookup (the window
  hook, the preview views' hook, realms and `window-workspace-target.ts`).
  The window hook's local gateway fallback also uses a nonthrowing bound-scope
  lookup (review correction, 2026-11-06). No credential is the
  safe answer for a request with no window; (b) keeps any other throw from
  leaving a request unanswered and main with an uncaught exception, and fails
  closed (credentials stripped, response headers untouched). Cons: (b) hides
  a future bug in a lookup behind a request without a credential; debug
  diagnostics now identify the failing hook phase without error or request
  content (review correction, 2026-11-06). The other `connectionIdForScope` callers still throw, which they
  should, because they act for a window. (c) has no signal from Electron that
  a session's requests have drained, so a close could wait indefinitely.
- **D23. Whether 0622 can close.** Options: (a) resolve it now; (b) keep it
  open until a loaded macOS run. Chose (a). Pros: the throw was reproduced
  without forcing at the same step (5 of 10 under CPU contention, none in 10
  runs without it), the fix removed it (10 of 10 under the same load, no
  `uncaught-exception` line), and unit tests that fail without the fix cover
  both changes. Cons: the 2026-10-21 macOS output was not kept, so that the
  blocking default error box held the release then is read from the code of
  that date rather than observed; a forced slow close gives the same message,
  and the step has told the two apart since 2026-10-21 (it now also records
  `releasedAfterMs` and prints main's uncaught exceptions on failure). (b)
  waits on hardware no run in this to-do has had.
- **D24. How the service-preview specs survive a startup that lost its
  modules.** Options: (a) reload the window, at most three times, only when
  the startup screen failed and that load's console holds both a failed module
  import and `net::ERR_NETWORK_CHANGED`; (b) route the window's loopback
  modules through `route.fetch()`, as the browser suite does; (c) run the specs
  only in a private network namespace. Chose (a). Pros: every request still
  goes through Chromium and main's webRequest hooks, where 0622's cause was;
  any other startup failure still fails; a packaged build loads from `file:`,
  so it cannot hide a user-facing failure; unit tested
  (`electron-startup-recovery.test.ts`). Cons: a reload adds seconds to a
  start; a burst of churn longer than three reloads still fails; no live run
  has shown a reload yet (none was hit after the change). (b) bypasses main's
  request hooks for exactly the loads that raced in 0622. (c) cannot reach
  Docker or the network, and `mise run test:agent:electron` does not run that
  way.
- **D25. Where the other client's layout save comes from (task 10).**
  Options: (a) a `BackendHttpClient` on the main window's own backend, through
  its gateway with the profile's token; (b) `save_pane_layout` through the
  window's own `invoke`, as `showTabs` does; (c) a second Electron window.
  Chose (a). Pros: it is a separate client by transport and identity, as a
  browser tab or the CLI is, and the spec already uses that client for the
  second backend. Cons: it does not exercise a second Electron window's
  writer. (b) is the same renderer's IPC path, so it says nothing about
  another client; (c) costs a second window and its own pane state for no
  extra coverage of the announcement path.
- **D26. How the 519 px toolbar case asserts the address width (task 10).**
  Options: (a) the measured pixel width with a small tolerance; (b) the
  layout structure plus the input holding at least two thirds of its row.
  Chose (b). Pros: the route chip and **Go** share the row and their width
  follows label text and platform fonts, so (a) would fail on a host with
  other fonts while (b) still fails on the old one-row layout (92 px, about
  18 %). Cons: a regression that shrinks the input by less than a few
  percent passes. The measured widths are recorded in the case's annotations
  and the evidence log.
- **D27. Node retention against a real command node (task 10).** Options:
  (a) leave it at unit level; (b) add it to task 1's two-machine session.
  Chose (a), the recommendation. Pros: ten unit tests cover the voucher
  logic, and a real multi-node setup needs the hardware task 1 waits on.
  Cons: the 30-minute registry read path is not seen end to end; task 1's
  session can still pick it up.

### D28. Task 10: keep each save's exact revision as the assertion baseline

Chose the revision returned by the remote save and independent no-write-back
checks after both adoptions. This catches echoes even before the next save can
read them. The previous follow-up-read baseline was convenient but could accept
an echoed revision; keeping it would leave the review's false-negative window.
Moving this case before the legacy Back case preserves its serial-suite signal
without skipping any case. The mutation probes above demonstrate that each
adoption now rejects a renderer write-back.

## Related

- [browser-previews.md](../../architecture/browser-previews.md) (operator guide),
  [remote-gateway.md](../../architecture/remote-gateway.md) §"Service previews".
- To-do 0054 (retired 2026-11-10; found by the hostile service-worker run,
  its read policy is in
  [browser-previews.md](../../architecture/browser-previews.md#private-https-origins)),
  [0046-embedded-service-previews.md](0046-embedded-service-previews.md),
  [0045-preview-service-discovery.md](0045-preview-service-discovery.md),
  [0044-web-annotation-qualification.md](0044-web-annotation-qualification.md) (same
  Electron harness; annotations run inside service tabs),
  to-do 5500 (retired 2026-11-10; [gateway security notes](../../architecture/remote-gateway.md#security-notes))
  (the gateway security spec's cases, run in the same Safari pass as task 3).
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
  for batching the macOS, Electron, two-machine and Safari runs;
  [0019-container-platform-qualification.md](../containers-and-environments/0019-container-platform-qualification.md)
  for Docker Desktop.
- [0018-container-network-and-credential-isolation.md](../containers-and-environments/0018-container-network-and-credential-isolation.md):
  egress policy must keep published loopback ports and relay stdio working.
- [`version-compatibility.md`](../../architecture/version-compatibility.md#the-support-window) (support
  window), [0023-environment-and-disk-cleanup.md](../containers-and-environments/0023-environment-and-disk-cleanup.md)
  (deletion-time cleanup), [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md)
  (gated runs).
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (tasks 1, 2, 3 and 12, the real-provider OAuth part of task 5, the pass-rule approval of task 6, the maintainer's fallback and legacy-annotation calls of task 8) moved there on 2026-11-10.

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
