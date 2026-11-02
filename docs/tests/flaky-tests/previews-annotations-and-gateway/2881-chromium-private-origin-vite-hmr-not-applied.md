# Chromium private-origin Vite HMR update not applied within 5 s

- **ID:** 2881
- **Status:** open
- **Date observed:** 2026-11-02
- **Test:** `[chromium] Vite HMR updates the page in the browser without a reload`
- **File:** `e2e/preview/private-origin.spec.ts:961`
- **Revision:** the to-do 1202 task 11 branch (`20261102-034214-6d91ec8292a6`, based on `38d55ee14`) before commit, as in [2880](2880-chromium-preview-ipv6-app-script-not-run.md).
- **Original command:** `ORKESTRATOR_TEST_PREVIEW_VITE_DIR=/tmp/preview-vite-6d91ec82 bunx playwright test --config e2e/preview/playwright.preview.config.ts --project=chromium private-origin --repeat-each=3`, one worker, Vite 7.3.6 fixture in an isolated copy, loaded host.
- **Failure:** `expect(locator('#app')).toHaveText("preview-vite v2")` timed out after 5 s; `#app` still read `preview-vite v1`. 44 passed, one failed (the second repetition) in 44.3 s.
- **Reruns:** the case alone on Chromium and Firefox, `--repeat-each=6`: 12 passed. The complete owner in file order on Chromium, `--repeat-each=3`: 45 passed. The full `test:preview:browser` run on Chromium and Firefox passed this case on both engines.
- **Assessment:** intermittent by the registry's rule. Same symptom as the Electron HMR case [1303](1303-vite-hmr-preview-fails-alone.md) (slow HMR delivery on a loaded host). The HMR socket is an upgrade and never pooled, but the follow-up `label.js` fetch does use the pool; nothing observed ties the failure to it. No implementation, assertion, timeout or skip changed.
