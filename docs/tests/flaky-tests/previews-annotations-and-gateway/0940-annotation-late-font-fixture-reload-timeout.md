# Annotation late-font case misses its fixture reload deadline under load

- **ID:** 0940
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `pins and Show on page stay on the target or become explicit offscreen, in a closed modal, and across a late-font shift`
- **File:** `e2e/agent-testing/web-annotations-electron.spec.ts:1811`
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=svc0042-suite-1 mise run test:logged -- --name ... -- mise run test:agent:electron` on branch `todo-0042-service-preview-rollout-f64ae24ade8a` (based on `00a0cb82e`), macOS 27.0 arm64, Electron 45.0.0, Playwright 1.64.0, one worker, host load 43 to 60.
- **Failure:** `Timeout 20000ms exceeded while waiting on the predicate` in the fixture script reload (`reloadFixtureScript`, whose preview reload resolves only after the load event a late font holds). Full suite: 31 passed, 3 failed (this, 0515 and 0941), 583.5 s.
- **Isolated reruns:** the unchanged owner failed the same test once more (`svc0042-owner-web-annotations-electron`: 8 passed, 1 failed, 4 not run after it, 114.3 s), then passed 13/13 (`svc0042-owner2-web-annotations-electron`, 118.6 s). The second full suite (`svc0042-suite-2`) passed it.
- **Not the branch's switches:** the branch moves three Chromium throttling switches into every Electron spec (`electron-launch-switches.ts`). An A/B of this one test passed 2/2 with and 2/2 without them (`svc0042-ab-switch-*`, `svc0042-ab-noswitch-*`).
- **Evidence:** `output/agent-testing/svc0042-suite-1/`, `svc0042-owner-web-annotations-electron/`, `svc0042-owner2-web-annotations-electron/`.
- **Hypothesis:** the late font and the reload's load event take longer than 20 s on a saturated host. Not established. No assertion, timeout or skip changed.
