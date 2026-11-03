# Environmental, not flaky: Chromium browser suites beside Docker network churn on a Linux host

- **ID:** 2340
- **Status:** environmental
- **Date observed:** 2026-11-01
- **Host:** beelink, Linux 7.1.8 (Arch-based), Intel Core Ultra 9 285H (16
  logical CPUs), Docker Engine 29.9.2 (rootful), Playwright 1.64.0 with its
  Chromium 156. Other worktrees' builds were creating and removing Docker
  networks and containers throughout (load averages 3–46).
- **Observation:** pages served from loopback (the component fixture's Vite
  server, or a profile's backend proxying the renderer's Vite server) lose
  module requests part-way through loading. The browser console shows
  `Failed to load resource: net::ERR_NETWORK_CHANGED` for a Vite module (for
  example `packages/protocol/src/graphs/system-contract.ts`), or the request
  ends with status -1 while the backend logs
  `[RemoteGateway] Proxy client disconnected; aborting upstream request`. The
  app then renders partly or not at all, and whichever assertion comes next
  times out:
  - `e2e/DesignCanvas.spec.ts` (desktop, 8x CPU throttle run for 0174): the
    reloaded canvas never showed the frame's heading (line 210,
    "element(s) not found" after 5 s); the module above failed with
    `ERR_NETWORK_CHANGED` right after `page.reload()`.
  - `e2e/agent-testing/design-canvas.spec.ts` "private canvases survive
    reload…": a blank dark page after the first `page.reload()`, failing in
    `ensureProjectExpanded` (line 341) three times in a row, with about 200
    module requests ending at status -1 in each trace.
  - The same `ERR_NETWORK_CHANGED` errors are the "blank fixture pages" in
    [0826](0826-scheduled-jobs-review-validation.md#browser-infrastructure),
    whose cause was not established.
- **Cause, reproduced:** on Linux, Chromium's network change notifier aborts
  in-flight requests, loopback included, with `ERR_NETWORK_CHANGED` when a
  network interface or address appears or disappears. Docker creates a bridge
  for every user network and a veth for every container start, and removes
  them again. A probe page loading 60 scripts from a loopback Bun server, each
  answered after 400 ms, 15 loads per run with Playwright's Chromium:
  - no churn of mine (other builds still active): 915 requests, 0 failed
    (65 s);
  - while `docker network create` and `docker network rm` of a labelled
    network ran every 0.5 s: 797 of 915 requests failed with
    `net::ERR_NETWORK_CHANGED` (9 s).
  - `ip monitor link address` on this host shows bridge and veth events every
    few seconds while other builds run; interface indexes were past 1,600
    after a day of uptime.
  - The probe's networks carried a throwaway `orkestrator-owner` label and
    were removed by that label afterwards.
- **Confirmation:** with its Vite module requests fetched through Playwright
  (`page.route` with `route.fetch()`, which bypasses Chromium's network
  stack), the private-canvas case's app loaded in six of seven runs on the
  same busy host (in the seventh, one routed fetch was reset) and passed
  twice. Those diagnostic runs also dismissed the container-fixture
  profile's Docker firewall warning and held the picker's first listing for
  [0208](../design-canvas-and-artifacts/0208-design-canvas-private-import-picker-disabled-in-suite.md);
  none of that was committed. No product or test code was changed for this
  case.
- **Not affected:** macOS with Docker Desktop, whose bridges live inside its
  VM, and CI runners, unless a job runs Docker work beside a browser suite.
  No Chromium switch to ignore these changes was found (the binary's strings
  name the notifier but no switch for it).
- **Also seen (2026-11-02):** `e2e/agent-testing/design-canvas-electron.spec.ts`
  run headless on beelink (`ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`,
  Electron 45.0.0) failed twice in a row at `openDesignWindow`: the
  Vite-served renderer showed "Orkestrator couldn't connect", the title check
  timed out after 150 s, and the diagnostics held 138
  `net::ERR_NETWORK_CHANGED` lines while other builds' containers connected
  and disconnected. The same journey against the packaged app
  (`design-canvas-packaged-electron.spec.ts`) passed in between: its renderer
  loads from `file://`, which this notifier does not abort.
- **Guidance:** on a Linux host, a browser failure whose trace shows
  `net::ERR_NETWORK_CHANGED`, or many requests ending at status -1, while other
  work starts or stops containers is this case, not a flake of the owning
  test. Rerun when no Docker work is starting or stopping, or route the
  page's module requests through `route.fetch()` for a diagnostic run. Do not
  add a new flake entry for the owning test unless its trace has neither
  symptom.

## 2026-11-03: project-home approval review

The six-worker `mise run test:logged -- --name review-browser -- mise run
 test:browser` rerun overlapped an origin/main Docker qualification on the same
Linux host. A separate one-worker `ProjectHomeMessageApproval.spec.ts` run had
three failures and one pass: blank pages never displayed the dialog. Its mobile
approve trace contains repeated `net::ERR_NETWORK_CHANGED` failures for local
Vite modules (including `SettingsMachineStrip.tsx` and
`VirtualizedMessageList.tsx`). This matches the cause above, rather than an
approval assertion rejecting rendered content. The broad run was interrupted
with SIGINT to its recorded Playwright child after 436.6 seconds so it could be
rerun without Docker churn. Evidence is retained under
`output/agent-testing/home-mail-review-fix/evidence/` in the review workspace.

After the Docker profile was stopped and reset, the one-worker approval spec
passed all four cases (22.8 s): approve and decline at mobile and desktop widths,
including Escape and keyboard assertions. The exact broad browser command was
rerun, but stopped after 25.3 minutes with 34 failures and 587 passes; it is not a
green aggregate result. Several unrelated cases reproduced on detached main;
others remain unresolved. An additional concurrent PipelineFlow owner run also
encountered `ENOENT` for trace files because these component-suite invocations
share `output/playwright/test-results`; that run is not reliable isolation
proof. Future component reruns must be serialized within one checkout as well
as kept separate from Docker network churn.

## 2026-11-03: a private network namespace avoids it

While validating to-do 2921 task 3 (branch
`close-retention-cases-4142aaf8cd0b-r1`, head `08e817a45`), the desktop Cursor
cases of `e2e/CloseRetention.spec.ts` failed twice in a row on beelink (load
average 63–87, about ten builds running), 5 failed and 1 passed each time.
Every failure except one waited for `New agent tab` after `page.reload()`, and
each of those traces held 111–359 `net::ERR_NETWORK_CHANGED` module requests;
`ip monitor all` showed veth and bridge events from other builds' containers
(interface indexes past 4,600).

The same command then passed, run inside a new user and network namespace that
has only loopback, so Chromium never sees the host's interfaces change:

```sh
unshare -rn sh -c 'ip link set lo up && ORKESTRATOR_E2E_PORT=<free port> mise run test:logged -- --name <name> -- bunx playwright test --config e2e/playwright.config.ts e2e/CloseRetention.spec.ts --project desktop-chromium --grep Cursor'
```

It passed all six Cursor cases (51.3 s), and the whole file in both projects
passed too (71.6 s). It only works for suites that need nothing beyond
loopback: the component fixture server, its fixture hosts and fake engines.
Inside the namespace the process is uid 0 in its own user namespace, which
Playwright's default (`chromiumSandbox: false`) already tolerates. It is not a
fix for suites that reach Docker or the network. No product or test code was
changed for this.
