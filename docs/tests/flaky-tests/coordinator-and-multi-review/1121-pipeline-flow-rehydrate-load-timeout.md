# Pipeline flow rehydration browser case times out in parallel aggregate

- **ID:** 1121
- **Status:** open
- **Date observed:** 2026-10-27
- **Test:** `a review pass rehydrates progress missed while inactive and after reload`
- **Owning file:** `e2e/PipelineFlow.spec.ts:292`
- **Original command:** `mise run test:logged -- --name flow-graph-browser -- mise run test:browser`
- **Failure:** Desktop Chromium exceeded the 30-second test timeout during `page.goto` in the parallel browser aggregate.
- **Suite counts:** 769 passed, 103 skipped, 42 failed across 914 tests.
- **Isolated rerun:** The complete owning file passed with one worker in 94.4 seconds, including this case.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.xMuhLD/flow-graph-browser.log.gz`; isolated owner run `pipeline-flow-browser-owner`.
- **Assessment:** The timeout occurred amid broad parallel browser timeouts on a heavily loaded host. No timeout or assertion was changed to obtain the isolated pass.
