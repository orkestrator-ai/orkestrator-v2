# Chromium preview IPv6 page loads without running its script

- **ID:** 2880
- **Status:** open
- **Date observed:** 2026-11-02
- **Test:** `[chromium] an IPv6-only service loads through its private origin`
- **File:** `e2e/preview/private-origin.spec.ts:936`
- **Revision:** the to-do 1202 task 11 branch (`20261102-034214-6d91ec8292a6`, based on `38d55ee14`) before commit: the private-origin proxy now reuses upstream connections, and `http1Request` resumes a reused socket itself.
- **Original command:** `ORKESTRATOR_TEST_PREVIEW_VITE_DIR=/tmp/preview-vite-6d91ec82 mise run test:logged -- --name preview-browser -- mise run test:preview:browser --project=chromium --project=firefox`, one Playwright worker, about ten other builds running on the host (beelink).
- **Failure:** `expect(locator('body')).toHaveAttribute("data-loaded", "browser-ipv6")` timed out after 5 s at line 942: the page signed in but `body` had no `data-loaded`, so `/assets/app.js` did not run. 38 passed, one failed, one skipped (Vite page-load bench on Firefox) in 1.1 min. The previous run of the same suite on the same tree passed this case.
- **Evidence:** `/tmp/orkestrator-test-run.bpWLA2/preview-browser.log.gz`. The trace was overwritten by later runs.
- **Reruns:** the case alone, `--repeat-each=8` on Chromium: 8 passed. The complete owner on Chromium in file order, `--repeat-each=3` (with the Vite fixture): 45 passed. The IPv6, srcset, source-map, revocation and upstream-pool cases on Chromium and Firefox, `--repeat-each=6`: 84 passed.
- **Assessment:** intermittent by the registry's rule. The cause is not established. Because the branch changes how upstream connections are reused, a reused connection failing in a way the forwarder does not retry (only a safe request whose reused connection closed before any response is resent) is a candidate; nothing observed confirms it. No implementation, assertion, timeout or skip changed.

## WebKit recurrence during backend logger main merge, 2026-11-02

The same IPv6-page assertion failed on WebKit at `private-origin.spec.ts:942`
while merging `0ec784293` into `08038e814` on the backend logger branch.
The command was `mise run test:logged -- --name merge-preview-browser -- mise run test:preview:browser`,
with all three engines and one Playwright worker. The suite reported 53 passed,
1 failed and 6 skipped in 113.9 seconds. The page's body lacked `data-loaded`
for the 5-second assertion window.

The complete unchanged owning file passed when rerun alone on WebKit:
`mise run test:logged -- --name merge-preview-webkit-owner -- mise run test:preview:browser --project=webkit e2e/preview/private-origin.spec.ts`
(exit 0, 19.3 seconds). The Vite fixture was not configured, so its HMR case
was skipped. No assertion, timeout or implementation changed for this rerun.
The observation establishes an intermittent failure on another engine; it
does not establish that the Chromium and WebKit failures share a cause.

Failure log: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.I1BXa5/merge-preview-browser.log.gz`.
