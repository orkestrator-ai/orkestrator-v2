# Design text fallback tab missing from persisted pane layout

- **ID:** 0380
- **Status:** open
- **Date observed:** 2026-10-17
- **Test:** `real gateway saves a design and rehydrates another client's edits`.
- **Owning file:** `e2e/agent-testing/design-canvas.spec.ts:12`.
- **Original command:** `mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated --no-agent-credentials` on credential-free Codex fixture profile `qa-browser-456a08a1-2d6`, based on `8a2f9444` plus the retired-dispatch recovery fixes.
- **Failure:** the five-second poll at line 183 never found `"filePath":".private/hidden.orkdes"` in `get_pane_layout` after opening the text fallback. The saved layout still contained only the default and design tabs.
- **Owning-file rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=qa-retired-owner-b37f ORKESTRATOR_AGENT_TEST_RUN_ID=retired-design-owner mise run test:logged -- --name design-owner -- mise run test:agent:browser -- e2e/agent-testing/design-canvas.spec.ts` passed both unchanged tests (68.0 seconds including CLI build) on a fresh credential-free Codex fixture profile.
- **Full isolated result:** 26 passed, 25 opt-in skips, two failed (the other failure is case 0224), 592.1 seconds including startup and cleanup. Both profiles were stopped and reset.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.SZD34s/isolated-browser.log.gz` and `output/agent-testing/qa-browser-456a08a1-2d6/browser/`; passing rerun results are under `output/agent-testing/retired-design-owner/browser/`.
- **Assessment:** the owning-file pass confirms intermittence; the cause is unconfirmed. No design implementation, assertion, timeout or skip was changed.
