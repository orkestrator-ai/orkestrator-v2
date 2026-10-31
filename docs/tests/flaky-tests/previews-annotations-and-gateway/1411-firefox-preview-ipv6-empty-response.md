# Firefox preview IPv6 navigation returns an empty response

- **ID:** 1411
- **Status:** open
- **Date observed:** 2026-10-30
- **Test:** `[firefox] an IPv6-only service loads through its private origin`
- **File:** `e2e/preview/private-origin.spec.ts:936`
- **Revision:** `f40221b13` plus review regressions in the private-TMPDIR integration and design renderer test files. The preview owner, harness and implementation were unchanged.
- **Original command:** `mise run test:logged -- --name preview-firefox-webkit-review -- bunx playwright test --config e2e/preview/playwright.preview.config.ts --project firefox --project webkit`, one Playwright worker.
- **Failure:** `page.waitForURL: NS_ERROR_NET_EMPTY_RESPONSE` in `signIn()` at line 118, called by the IPv6 case. The complete two-engine run reported 14 passed, one skipped, three failed and 14 not run in 38.9 s. The other two failures were WebKit's missing host shared libraries, not intermittent assertions.
- **Evidence:** `/tmp/orkestrator-test-run.OFFGqx/preview-firefox-webkit-review.log.gz` and `summary.json`. The preceding run in `/tmp/orkestrator-test-run.qXH2ZJ/` lacked both browser binaries and is installation evidence only.
- **Complete owner rerun:** `mise run test:logged -- --name preview-firefox-owner-review -- bunx playwright test --config e2e/preview/playwright.preview.config.ts e2e/preview/private-origin.spec.ts --project firefox` passed unchanged in 22.8 s (14 passed, one optional Vite HMR case skipped). Summary: `/tmp/orkestrator-test-run.5VpIqG/summary.json`.
- **Exact original command rerun:** After providing WebKit's missing libraries from the existing pinned Playwright image in its user-local browser cache, both projects passed in 47.8 s. Summary: `/tmp/orkestrator-test-run.a7jO4r/summary.json`. The optional Vite HMR cases remained disabled because no fixture directory was configured.
- **Assessment:** The unchanged complete-owner pass establishes intermittence. The cause of the empty response remains unconfirmed; no implementation, assertion, timeout or skip changed.
