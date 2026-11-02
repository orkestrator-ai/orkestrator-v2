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
