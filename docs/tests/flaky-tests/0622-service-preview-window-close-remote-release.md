# Remote preview attachment still held 20 s after its window closed

- **ID:** 0622
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `windows on different backends never share previews, and switches
  release on the issuing backend` in
  `e2e/agent-testing/service-preview-electron.spec.ts`, the window-close step.
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=svc-preview-0a835-last bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-electron.spec.ts`,
  one worker, macOS 27.0 arm64 shared with other live-test worktrees (load
  average 20 to 26). The run was slow: 12 passed and 1 failed in 1.9 min,
  against about 1 min normally.
- **Failure:** after `BrowserWindow.close()` on window 2 (on the second
  backend), the second backend still reported 1 preview attachment when the
  20-second poll ended. The earlier steps of the same test (release after a
  switch to Local, and after `connect`) had passed in that run.
- **Passes:** the step passed in every other full run on 2026-10-21 (more
  than 20, including the full Electron suite), and in 4 runs right after
  (window gone 209 to 217 ms after `close()`).
- **Code path:** the `closed` handler in `main.ts` destroys the window's
  previews, then disposes the transport, which releases each attachment
  through `connectionPreviewBackend`. That keeps the last client it used, so
  the release still reaches the second backend after `connectionManager.release(scope)`
  drops the connection. Reading the code gives no reason for a 20-second hold.
- **Hypothesis:** the window closed late under load (the old step started its
  20 s poll at `close()`, not when the window was gone). Not confirmed:
  Electron's stdout, where a failed release would be logged as
  `[Previews] Failed to close preview transport`, is not captured by the spec.
- **Change:** the step now waits up to 30 s for the window to be gone, then
  polls the release for 20 s. On failure it reports how long the close took,
  how long since `close()`, and the Local backend's access counts. No timeout
  was raised for the release itself and no test was skipped.
- **Evidence:** `output/agent-testing/svc-preview-0a835-last` (failure),
  `output/agent-testing/svc-preview-0a835-close-1` to `-4` (passes, with
  `window-close` timings).
