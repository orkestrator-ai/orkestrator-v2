# Seeded preview check 2 never sees environment B's preview (`e2e/agent-testing/service-preview-seeded-electron.spec.ts`)

- **ID:** 9801
- **Status:** open
- **Date observed:** 2026-11-15
- **Test:** `2. with both servers running each environment opens only its own, and a moved server is offered as a move`
- **File:** `e2e/agent-testing/service-preview-seeded-electron.spec.ts:606`
  (failing assertion at line 321)
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=7062-mbp3-electron mise run test:logged -- --name agent-electron -- mise run test:agent:electron`
  on mbp3's own display (to-do 7062 (retired), branch
  `electron-network-recovery-6f0e256abdac-r1`, base `0cc406750`).
- **Worker configuration:** macOS 27.2 arm64, Bun 1.4.4, Playwright 1.65.0,
  Electron 45.2.3, one worker, the whole Electron suite. Other worktrees'
  Electron runs were active on the host.
- **Failure:** after 61.5 s, `a visible preview showing
  /^seeded-origin-seeded-b-f39b872db873-(\d+)$/`, `Timeout 60000ms exceeded
  while waiting on the predicate`, last state `[]` (no visible preview view in
  the main window). The later serial checks were skipped. Suite counts: 66
  passed, 4 failed, 15 skipped of 85.
- **Isolated rerun:** `ORKESTRATOR_AGENT_TEST_RUN_ID=7062-rerun-service-preview-seeded-electron mise run test:logged -- --name rerun-service-preview-seeded-electron -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-seeded-electron.spec.ts`
  passed (6 passed, 55.3 s).
- **Evidence:** `output/agent-testing/7062-mbp3-electron/electron/` in that
  worktree (git-ignored): `results.json`, `error-context.md`,
  `electron-diagnostics.txt` and the trace.
- **Hypothesis:** none established. Same test as
  [4470](4470-seeded-preview-moved-port-link-not-printed.md) but a different
  step: there the moved server's address was never printed; here environment
  B's preview never became visible.
- **Related change:** to-do 7062 (retired) touched only the Electron config's
  spec list and added `startup-recovery-electron.spec.ts`; the seeded spec's
  startup passed and the failure is later.
