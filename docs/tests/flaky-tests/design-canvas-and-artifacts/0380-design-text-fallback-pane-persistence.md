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


## Session lifecycle review validation — 2026-10-23

- `mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated` used disposable profile `qa-browser-610703cf-bf8`, one browser worker and no provider credentials. It reported 28 passed, 51 skipped, one failed out of 80 (722.7 s logged).
- The saved pane layout still lacked `"filePath":".private/hidden.orkdes"` at `design-canvas.spec.ts:184` after five seconds.
- The complete unchanged owner was rerun using `mise run test:logged -- --name design-owner -- mise run test:agent:design:isolated` on fresh profile `qa-browser-7ef96497-b69`: one passed, one failed (103.4 s logged), with the same missing hidden-text tab. This recurrence remains non-green in isolation and is not newly classified as intermittent.
- Evidence: `orkestrator-test-run.4adnVD/isolated-browser.log.gz` and `orkestrator-test-run.82NO6y/design-owner.log.gz` under the host temporary directory; traces and screenshots in each profile's `output/agent-testing/<profile>/browser/artifacts/`.
- Both launchers stopped and both profiles were reset by the isolated runners. No design implementation, assertion, timeout, or skip changed.

## Control MCP voice main merge — 2026-10-24

- **Full command:** `mise run test:agent:browser:isolated` on credential-free Codex fixture `qa-browser-a34c7ac6-c9f`, one worker, with other validation on the host. At `design-canvas.spec.ts:184`, the saved pane layout lacked `"filePath":"d1/d2/d3/d4/d5/d6/d7/d8/deep.orkdes"` after five seconds. The run later reached its browser deadline without a complete suite summary and stopped/reset its profile.
- **Complete unchanged owner:** `ORKESTRATOR_AGENT_TEST_PROFILE=merge-gateway-0041-fc04c130 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-0041-design-owner mise run test:logged -- --name merge-0041-design-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/design-canvas.spec.ts --workers=1` passed both tests (112.9 s, exit 0). This credential-free Codex fixture had completed the gateway owner first; no browser tests ran concurrently against that profile.
- **Evidence:** `output/agent-testing/qa-browser-a34c7ac6-c9f/browser/artifacts/design-canvas-real-gateway-ef5b9-ates-another-client-s-edits/` and passing results under `output/agent-testing/merge-0041-design-owner/browser/`.
- **Assessment:** another unchanged-owner pass confirms this observation is intermittent; the cause remains unconfirmed. No design implementation, assertion, deadline or skip changed. The owner profile was stopped/reset after the checks.


## Runtime-state ownership main merge — 2026-10-24

The merge parents are feature `3b5f889149d8c3603c869cd15b51d67af39c9aa6` and main `0014505caeed69395b3cc996dd541fcc6df12c23`. The renderer and both browser owning files match `origin/main`; no assertion, timeout or skip changed. `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated` used credential-free Codex profile `qa-browser-a81b23d3-fdf`, one browser worker, alongside other validating worktrees. It reached its 900 s test deadline after starting case 56 of 83, with four recorded failures and no complete Playwright summary (923.2 s including lifecycle). Its runner stopped/reset the profile. Evidence: host temporary artifact `orkestrator-test-run.flXegA/merge-isolated-browser.log.gz`. The pane-layout poll at `design-canvas.spec.ts:184` lacked `d1/d2/d3/d4/d5/d6/d7/d8/deep.orkdes` at five seconds. The complete unchanged design owner ran with `ORKESTRATOR_AGENT_TEST_PROFILE=merge-runtime-docker-1024 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-runtime-docker-1024-design mise run test:logged -- --name merge-design-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/design-canvas.spec.ts --workers=1`: one passed, one failed (106.6 s logged). The text-fallback layout case still lacked `.private/hidden.orkdes` at its five-second poll; the private import-picker case passed. Evidence: host temporary artifact `orkestrator-test-run.CJdR89/merge-design-owner.log.gz` and `output/agent-testing/merge-runtime-docker-1024-design/browser/`. The recurrence remains non-green in isolation; this is not a newly confirmed intermittent observation.
