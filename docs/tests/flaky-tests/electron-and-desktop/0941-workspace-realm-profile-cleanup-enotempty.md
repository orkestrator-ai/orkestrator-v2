# Workspace realm spec cleanup hits ENOTEMPTY on its temporary profile

- **ID:** 0941
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `a leaf's workspace opens in the window's central region without moving or reloading the window`
- **File:** `e2e/agent-testing/workspace-realm-electron.spec.ts:162`
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=svc0042-suite-1 mise run test:agent:electron` through `test:logged`, branch `todo-0042-service-preview-rollout-f64ae24ade8a` (based on `00a0cb82e`), macOS 27.0 arm64, Electron 45.0.0, one worker, host load 43 to 60.
- **Failure:** `ENOTEMPTY: directory not empty, rmdir '<tmp>/orkestrator-electron-realm-*/dev/profiles/electron-realm/data/design-canvases'` while the spec removed its temporary root, so something was still writing into the profile's `design-canvases` directory during cleanup. Different from 0840 (DOM focus) in the same test.
- **Isolated rerun:** the unchanged owner passed alone (`svc0042-owner-workspace-realm-electron`, 1 passed, 63.0 s), and the second full suite (`svc0042-suite-2`) passed it.
- **Evidence:** `output/agent-testing/svc0042-suite-1/electron/results.json`.
- **Hypothesis:** a backend or design-canvas writer had not exited when the recursive remove ran. Not established. No assertion, timeout or skip changed.
