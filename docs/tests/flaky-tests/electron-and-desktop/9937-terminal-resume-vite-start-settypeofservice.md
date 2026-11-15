# Terminal input resume spec fails with `setTypeOfService EINVAL` while Vite starts (`e2e/agent-testing/terminal-input-resume-electron.spec.ts`)

- **ID:** 9937
- **Status:** open
- **Date observed:** 2026-11-15
- **Test:** `Electron keeps a lost terminal write fenced until Resume, without restarting the PTY`
- **File:** `e2e/agent-testing/terminal-input-resume-electron.spec.ts:108`
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=7062-mbp3-electron mise run test:logged -- --name agent-electron -- mise run test:agent:electron`
  on mbp3's own display (to-do 7062 (retired), branch
  `electron-network-recovery-6f0e256abdac-r1`, base `0cc406750`).
- **Worker configuration:** macOS 27.2 arm64, Bun 1.4.4, Node 24.22.1 for the
  Playwright worker, Playwright 1.65.0, Electron 45.2.3, one worker. Other
  worktrees' Electron runs were active on the host.
- **Failure:** after 1.6 s, `Error: setTypeOfService EINVAL`, with no source
  location. The trace and the run's Electron diagnostics end while the spec's
  Vite server is still starting, before Electron is launched, so the error was
  thrown in the test worker, not in Electron's main. Suite counts: 66 passed,
  4 failed, 15 skipped of 85.
- **Isolated rerun:** `ORKESTRATOR_AGENT_TEST_RUN_ID=7062-rerun-terminal-input-resume-electron mise run test:logged -- --name rerun-terminal-input-resume-electron -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts terminal-input-resume-electron.spec.ts`
  passed (1 passed, 62.6 s).
- **Evidence:** `output/agent-testing/7062-mbp3-electron/electron/` in that
  worktree (git-ignored): `results.json`, `error-context.md`,
  `electron-diagnostics.txt` and the trace.
- **Hypothesis (unconfirmed):** the same undici defect that
  `apps/desktop/electron/socket-tos-guard.ts` guards in Electron's main: on
  macOS `setsockopt` returns EINVAL once the peer has reset the connection,
  and undici 7 calls `setTypeOfService` without a try/catch. Here it would be
  the worker's own `fetch` polling a server that was not yet listening or
  reset the connection. Which request it was was not observed.
- **Related change:** to-do 7062 (retired) touched only the Electron config's
  spec list and added `startup-recovery-electron.spec.ts`; nothing on this
  spec's Vite start path.
