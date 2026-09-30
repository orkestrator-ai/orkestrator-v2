# Dev renderer entry fails to load with "Failed to fetch dynamically imported module"

- **ID:** 0167
- **Status:** environmental
- **Date observed:** 2026-09-26
- **Tests:** cases in `e2e/agent-testing/native-draft-attachments.spec.ts` that load
  the app right after a previous case deleted its environments
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=inconsistency-remediation-qa bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts native-draft-attachments`
  against a `dev:test --fixture` profile on branch
  `implement-improvements-ecf7c41c13cd-r1`
- **Failure:** the page showed "Orkestrator couldn’t connect". The renderer's
  console showed `[DesktopStartup] renderer-load-failed` with `Failed to fetch
  dynamically imported module: http://127.0.0.1:<gateway>/src/renderer-entry.tsx`.
  The backend kept running and logged no error. Two of three full runs of the
  spec hit it once each, on different cases.
- **Isolated check:** twelve consecutive loads of the same profile, with no
  environment churn, all started normally.

## Current assessment

This is the Vite dev server (through the gateway proxy) failing one source-module
fetch under load. A production build serves a bundle and has no such fetch.
The draft spec retries the load once, only for this exact startup message, and
records the retry as a `retry` annotation. Any other startup failure still fails
the case. Keep this open as environmental until the dev gateway's module
fetches are shown to fail for another reason.

## Recurrence — 2026-09-27

- **Tests:** `e2e/agent-testing/container-settings.spec.ts` (desktop and narrow)
  run right after `container-rebuild-cycle.spec.ts`, while that case's
  preserving rebuild was still copying and starting the new container.
- **Command:** `ORKESTRATOR_AGENT_TEST_PROFILE=containers-audit-qa mise run test:agent:docker`
  against a `dev:test --fixture --fixture-environments local,container`
  profile on branch `implement-containers-50431d61c9b0-r1`.
- **Failure:** "Orkestrator couldn’t connect" on the page load; the backend
  kept running, logged no error, and answered CLI reads in ~50 ms throughout.
- **Isolated check:** four page loads during a CLI-started rebuild all started
  in ~2 s; two further full runs of the Docker suite passed 5/5.
- **Change:** both container specs now load through
  `e2e/agent-testing/dev-startup-retry.ts`, the same single, annotated retry
  the draft spec uses, limited to the dev server's module-fetch failure.

## Recurrence — 2026-09-30

- **Test:** `real browser gateway exercises an authoritative local environment`
  in `e2e/agent-testing/browser-gateway.spec.ts`, after the account-switching case.
- **Original command:** `mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated`
  on branch `logged-out-message-fc70c7944c03-r1`, one browser worker, while the
  repository suite was running.
- **Failure:** the renderer showed "Orkestrator couldn’t connect" instead of
  the fixture project. Its trace recorded a 502 and `[DesktopStartup]`
  `Failed to fetch dynamically imported module: .../src/renderer-entry.tsx`.
  The suite finished with 11 passed, 2 failed and 10 skipped; the second failure
  was in the unrelated draft spec's narrow-viewport assertion.
- **Isolated rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=qa-auth-review-fc70c794 ORKESTRATOR_AGENT_TEST_RUN_ID=qa-auth-review-fc70c794-complete mise run test:logged -- --name auth-browser-complete -- mise run test:agent:browser -- e2e/agent-testing/browser-gateway.spec.ts --workers=1`
  passed the complete owning file: 5 passed, 3 opt-in skips, exit 0 (30.6 s).
  This includes the new signed-out Codex account/recovery scenario. The
  repository suite had finished before this rerun.
- **Evidence:** original logged failure at
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.FEyvYt`;
  sanitized browser artifacts at
  `output/agent-testing/qa-browser-dc912226-dd9/browser/` and the passing rerun's
  result at `output/agent-testing/qa-auth-review-fc70c794-complete/browser/results.json`.
- **Assessment:** the trace matches this existing dev-module-fetch failure;
  status remains environmental. Both disposable profiles were stopped and reset.
