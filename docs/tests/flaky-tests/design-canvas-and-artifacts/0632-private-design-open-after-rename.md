# Private design open action absent after a narrow-layout rename

- **ID:** 0632
- **Status:** open
- **Date observed:** 2026-10-22
- **Test:** `private canvases survive reload and can be retired to recover quota`.
- **Owning file:** `e2e/agent-testing/design-canvas.spec.ts:239`.
- **Original command:** `mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated`.
- **Profile / branch:** credential-free Codex fixture `qa-browser-f042f724-984`,
  `fix-environment-indentation-fc91d4557412-r1` with sidebar review fixes.
- **Failure:** after switching to 720 × 900, renaming `Imported private canvas`
  and selecting the renamed entry, the `Open beside` action never appeared
  within 15 seconds (line 376). The full suite finished with 27 passed,
  42 opt-in skips and two failures; the other failure is existing case 0224.
- **Evidence:**
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.9o1S1h/isolated-browser.log.gz`
  and `output/agent-testing/qa-browser-f042f724-984/browser/artifacts/design-canvas-private-canv-b923a-be-retired-to-recover-quota/trace.zip`.
- **Owning-file rerun:** the complete unchanged design owner passed both tests
  (33.5 seconds) on fresh credential-free fixture `qa-sidebar-review-repro`:
  `ORKESTRATOR_AGENT_TEST_PROFILE=qa-sidebar-review-repro mise run test:logged -- --name design-owner-rerun -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/design-canvas.spec.ts`.
  Results: `output/agent-testing/qa-sidebar-review-repro/browser/results.json`.
- **Assessment:** intermittent in this validation. Production renderer sources
  were edited during the original aggregate run, so Vite refresh is a possible
  cause; this is unconfirmed. No source edits occurred during the passing owner
  rerun. No assertion, timeout or skip was weakened. Both profiles were stopped
  and reset.
