# Multi Review flow browser reload cases time out in parallel aggregate

- **ID:** 1120
- **Status:** open
- **Date observed:** 2026-10-27
- **Test:** MultiReviewFlow browser reload and divider cases
- **Owning file:** `e2e/MultiReviewFlow.spec.ts`
- **Original command:** `mise run test:logged -- --name flow-graph-browser -- mise run test:browser`
- **Failure:** Four retained clean-review PR snapshot cases timed out in `page.reload`; three divider capture cases timed out while reloading in desktop Chromium.
- **Suite counts:** 769 passed, 103 skipped, 42 failed across 914 tests.
- **Isolated rerun:** The complete owning file passed with one worker in 287.5 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.xMuhLD/flow-graph-browser.log.gz`; isolated owner run `multi-review-flow-browser-owner`.
- **Assessment:** These failures occurred among broad parallel browser timeouts on a heavily loaded host. No timeout or assertion was changed to obtain the isolated pass.
