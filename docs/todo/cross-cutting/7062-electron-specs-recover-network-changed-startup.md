# Electron specs recover a startup that lost its modules to ERR_NETWORK_CHANGED

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`, with branch
`preview-flakes-1bb27c3be3fd-r1` at `9ef37bfd1`. Found while repairing the
review validation of to-do 0042 task 11.

### Tasks

1. **Use the startup recovery in the other Electron specs**: every spec that
   waits for a development window's first title. Status: open.
2. **Measure it under forced network churn**: show a real reload recovering a
   startup. Status: open (depends on 1).

### 1. Use the startup recovery in the other Electron specs

**Problem.** On a Linux host where other builds create and remove Docker
networks, Chromium aborts a development window's Vite module loads with
`net::ERR_NETWORK_CHANGED`, the window stops at "Orkestrator couldn’t connect",
and the spec fails at its first title check
([2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md)).
The 2026-11-06 review validation of to-do 0042 task 11 (`mise run
test:agent:electron`, head `f67ef0666`) had 20 failures, 17 of them at a first
`toHaveTitle`.

**Context.** `e2e/agent-testing/electron-startup-recovery.ts`
(`waitForRendererStart`, `collectStartupConsole`) reloads a window, at most
three times, only when the startup screen failed and that load's console holds
both a failed module import and `net::ERR_NETWORK_CHANGED`. Since `9ef37bfd1`
only `service-preview-electron-launch.ts` uses it.
`workspace-realm-electron.spec.ts:139` has its own looser version (reloads on
the failure screen whatever the cause, and routes modules through
`fetchModulesOutsideChromium`). The other first-title waits are in
`electron-main.spec.ts` (`:279`, `:708`), `local-gateway-transport-electron.spec.ts`
(`:299`, `:360`, `:513`, `:681`), `renderer-log-boundary-electron.spec.ts`,
`pull-request-pane-electron.spec.ts`, `terminal-input-resume-electron.spec.ts`,
`connection-outage-electron.spec.ts`, `relayed-events-electron.spec.ts`,
`artifact-host-electron.spec.ts`, `web-annotations-electron.spec.ts:170` and
`design-canvas-electron-journey.ts:96`.

**Investigation.** Several of that run's other failures have
`net::ERR_NETWORK_CHANGED` and `renderer-load-failed` lines in their attached
`electron-diagnostics.txt`, but the buffer spans the worker, not one test, so
which case each line belongs to was not established. The review triage left
them undetermined. Not every first-title wait should recover:
`renderer-log-boundary-electron.spec.ts` checks the startup markers a window
sends, and `electron-main.spec.ts:929` expects a window with a missing preload
to reach recovery; a reload there could hide what the case is about.

**Decisions.**

- **Where to apply it?**
  - **Each spec's own launch helper, one spec at a time, skipping the cases
    that assert on startup failure (recommended).**
    - Pros: the same narrow rule as the service-preview launcher; a case about
      startup keeps seeing the first load.
    - Cons: a dozen call sites, each needing a look at what its case asserts.
  - **One shared launch helper for every Electron spec.**
    - Pros: one place.
    - Cons: the specs launch with different environments and profiles today;
      merging them is a larger refactor than this needs.
  - **Route modules through `route.fetch()` as the browser suite does.**
    - Pros: no reload at all.
    - Cons: those loads skip main's webRequest hooks, which several Electron
      specs exist to exercise (flake 0622's cause was in one).

### 2. Measure it under forced network churn

**Problem.** The service-preview runs after `9ef37bfd1` (10/10 and 10/10 on the
two owning tests, 21/21 owner, 6/6 seeded, 10 separate cold launches) printed
no `[startup-recovery]` line: no network change hit a startup then. The reload
is proven by `electron-startup-recovery.test.ts`, not by a live recurrence.

**Context.** 2340 reproduced the aborts with a labelled network created and
removed every 0.3 s.

**Investigation.** Not run: on a shared host that churn aborts every other
build's Chromium loads too.

**Decisions.**

- **How to measure?**
  - **Force churn inside a private network namespace (`unshare --user --net`)
    by adding and removing a dummy interface there, so only the run sees it
    (recommended).**
    - Pros: no effect on other builds; needs no Docker.
    - Cons: a dummy link may not trigger Chromium's notifier the way a Docker
      bridge does; check that first.
  - **Labelled Docker network churn on a quiet host.**
    - Pros: the exact recorded trigger.
    - Cons: needs a host with no other builds running.

## Related

- [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md)
- [to-do 0042](../previews-and-annotations/0042-service-preview-rollout.md)
  (task 11, D24)
- [4222](4222-browser-failures-left-after-headless-qualification.md), the
  browser suite's module routing
