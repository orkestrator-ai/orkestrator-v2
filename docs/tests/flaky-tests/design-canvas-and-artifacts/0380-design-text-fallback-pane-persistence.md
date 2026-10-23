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
