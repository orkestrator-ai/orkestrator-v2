# Annotation capture after the forced-DPR-2 relaunch misses or shows a stale frame (`e2e/agent-testing/web-annotations-electron.spec.ts`)

- **ID:** 9806
- **Status:** open
- **Date observed:** 2026-11-16, while closing to-do 0044 (retired); branch
  `20261116-202159-e8c516ff60f3` from `main` at `a0920f1a7`
- **Test:** `capture pixels stay on the target at preview zoom 0.8, 1 and 1.5 and at DPR 1 and 2`
- **File:** `e2e/agent-testing/web-annotations-electron.spec.ts` (failing at the
  first capture after `relaunch(["--force-device-scale-factor=2"])`, label
  `forced-direct-dpr-2-zoom-0.8`)
- **Original command:**
  `env -u DISPLAY -u WAYLAND_DISPLAY -u ELECTRON_OZONE_PLATFORM_HINT ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1 ORKESTRATOR_HOST_REACHABILITY_CHECK=off ORKESTRATOR_AGENT_TEST_RUN_ID=q0044-electron-1116 unshare -rn sh -c "ip link set lo up && exec unshare --user --map-user=$(id -u) --map-group=$(id -g) mise run test:logged -- --name q0044-electron-1116 -- bunx playwright test --config e2e/agent-testing/playwright.electron-headless.config.ts web-annotations-electron.spec.ts --workers=1"`
  (and `q0044-electron-1116-2`, the same command again).
- **Worker configuration:** beelink, Linux 7.1.8 (x86_64, 16 logical CPUs),
  Electron 45.2.3 headless, Playwright 1.65.0, one worker, the whole owning
  file, inside a loopback-only network namespace. Other pipelines were
  running: load average 40 to 43.
- **Failures:** both full runs failed this case at the same step; every other
  local case passed (15 passed, 2 skipped as container opt-ins, 1 not run
  after it; 161 s and 146 s).
  - Run 1: `Capture did not end: {"status":"selecting",…,"mode":"element"}`
    after 20 s: the trusted click on the marker never selected it.
  - Run 2: `forced-direct-dpr-2-zoom-0.8 highlight: {"box":{"x":400,"y":280,"width":188,"height":100},"expected":{"x":320,"y":224,"width":256,"height":144}}`.
    The capture's geometry said zoom 0.8 and device pixel ratio 1.6, but its
    pixels were painted at zoom 1: the marker (CSS 200, 140, 160 × 90) sits
    at 400, 280, about 320 × 180 image pixels, that is ×2 rather than ×1.6,
    and the page header is at full size. The image (attached by the case
    since this change) is in run 2's `results.json`.
- **Isolated rerun:** the case alone passed at once
  (`--grep 'capture pixels stay'`, run `q0044-electron-1116-align`, 56 s,
  same load). The whole file passed it headless on 2026-11-06 and
  2026-11-11.
- **Evidence:** `output/agent-testing/q0044-electron-1116/` and
  `q0044-electron-1116-2/` in that worktree (results, traces, Electron
  diagnostics).
- **Hypothesis:** a stale composited frame. The capture's prepare step
  (`waitForPaint` in `apps/desktop/electron/browser-preview-annotation-script.ts`)
  resolves after two animation frames or 150 ms, whichever is first, and
  `capturePage()` then takes the last frame the compositor produced. On a
  saturated host just after a relaunch, the 150 ms timeout can win before the
  frame with the new zoom (or the selection) is painted. If so this is a
  product race, not only a test one: on a slow machine a capture could carry
  pixels older than its geometry. Not established; nothing was changed. The
  next step is to reproduce it with the paint wait instrumented (which of the
  two finished it) before choosing between waiting for a real frame in the
  product and waiting for the zoom to apply in the spec.
