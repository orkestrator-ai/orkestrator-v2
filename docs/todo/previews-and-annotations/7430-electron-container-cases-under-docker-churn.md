# Electron annotation container cases on a Linux host with Docker churn

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab7`. Split from
[0044](0044-web-annotation-qualification.md) task 8, which ran every other
source-hint case on Linux that day.

### Tasks

1. **Run the two Electron container source-hint cases on Linux**: `a desktop capture in a container environment has its source hints checked inside the container` and `the same Vite dev-server capture in a container environment is checked inside the container`, with `ORKESTRATOR_AGENT_TEST_ELECTRON_CONTAINER=1`. Status: open.
2. **Give the Electron specs' renderer a path that Docker churn cannot abort**: so a container case can run in the host network namespace on a busy Linux host. Status: open (task 1 depends on it on beelink).

### 1. Run the two Electron container source-hint cases on Linux

**Problem.** Desktop capture in a container environment, the source hints
checked inside the container, has run on macOS only (2026-10-25). On Linux the
two Electron cases have never passed: neither the fixture-HTML case nor the
real Vite dev-server case added on 2026-11-06.

**Context.** Both cases are in `e2e/agent-testing/web-annotations-electron.spec.ts`
and share `inContainerEnvironment`. They need Docker and this worktree's image
(`mise run docker:build:dev`). The gateway's container source-hint case
(`web-annotations-gateway.spec.ts`, `Docker fixture checks source hints`)
passed on Linux on 2026-11-06, so the backend's check inside `/workspace` is
proved there; what is missing is the desktop producer feeding it.

**Investigation.** On beelink on 2026-11-06 (load average 20–80, other
pipelines starting and stopping containers):

- Inside a loopback-only network namespace (the 2340 workaround) the local
  cases pass, but creating the container environment failed with
  `ContainerLifecycleError:resource-exhausted: Docker has no free address range
  for another environment network`. The test-only shim
  `apps/desktop/scripts/dev/docker-qualification-bin` that falls back to an
  unrouted `/29` needs a default route, which the namespace does not have, and
  the backend reaches a container's bridges through ports Docker publishes in
  the host namespace.
- In the host namespace with the shim on `PATH`, both attempts failed before
  the first test: the Vite-served renderer never loaded (`toHaveTitle` timed
  out on "Orkestrator AI", 66 and more than 60 `net::ERR_NETWORK_CHANGED` lines
  in the diagnostics). That is
  [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md).

Steps, on a Linux host with Docker and no other Docker work running (or after
task 2):

1. `mise run docker:build:dev --profile <any>`.
2. `env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1 ORKESTRATOR_AGENT_TEST_ELECTRON_CONTAINER=1 mise run test:logged -- --name electron-container -- bunx playwright test --config e2e/agent-testing/playwright.electron-headless.config.ts web-annotations-electron.spec.ts --workers=1 --grep "container environment"`,
   with the shim directory first on `PATH` if automatic pools are exhausted.
3. Record the stored `verified` flags of both cases (expected
   `[true, false]` for the fixture HTML, `[true, true]` for the Vite app) in
   0044's run log and the capability matrix.

**Decisions.**

- **Which host?**
  - **beelink after task 2 (recommended).**
    - Pros: the same host as the rest of 0044's Linux evidence; no person
      needed.
    - Cons: waits on task 2.
  - **beelink in a quiet window, or another Linux host with no other Docker
    work.**
    - Pros: no code change.
    - Cons: a quiet window cannot be scheduled from a pipeline; the run
      stays hostage to other builds.

### 2. Give the Electron specs' renderer a path that Docker churn cannot abort

**Problem.** Every Vite-served Electron spec on a Linux host with Docker
network churn can lose its renderer before the first test (2340). The
namespace workaround avoids it only for specs that need nothing outside
loopback.

**Context.** The browser suites already avoid it by fetching modules outside
Chromium (`e2e/agent-testing/browser-test.ts`). The packaged-app Electron
specs are immune because their renderer loads from `file://`. The annotation
spec's renderer comes from `bun run dev` in `apps/web` (`VITE_DEV_SERVER_URL`).

**Investigation.** Not started. The renderer's own code is what the
annotation spec tests (the Notes column, the real BrowserTab), so a
replacement must still be the real renderer.

**Decisions.**

- **How to load the renderer?**
  - **A built renderer served from `file://` for the specs that do not
    need hot reload (recommended).**
    - Pros: the mechanism the packaged specs already prove immune; no
      Chromium request interception.
    - Cons: a `vite build` per run (or a cached one keyed on sources); specs
      that rely on dev-only renderer hooks (`uiStore` imported by path)
      need another way in.
  - **Intercept the renderer's module requests in main
    (`protocol.handle`) and fetch them outside Chromium's network stack.**
    - Pros: keeps the Vite dev server and its module paths.
    - Cons: a test-only interception layer inside Electron main, which the
      production app must never carry.

## Related

- [0044-web-annotation-qualification.md](0044-web-annotation-qualification.md)
  task 8 and its "Runs on 2026-11-06 (Linux, beelink)".
- [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md).
- [3320](../containers-and-environments/3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md)
  for the exhausted address pools on beelink.
