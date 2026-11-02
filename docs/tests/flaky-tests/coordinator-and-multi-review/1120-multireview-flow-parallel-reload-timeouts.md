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


## Backend logger review repair — 2026-11-02

The four-worker `review-fix-browser` command documented in
[1902](../web-ui/1902-assigned-composer-shortcut-startup.md#backend-logger-review-repair--2026-11-02)
reported four mobile 30-second deadlines in this owner:

- `a retained clean-review PR notice reflects the current ready snapshot after reload`
- `a retained clean-review PR notice reflects the current interactive snapshot after reload`
- `divider follows a captured mouse at 150% application CSS zoom`
- `divider follows a captured mouse at 75% application CSS zoom`

The interactive case timed out while clicking the PR tab, and the 75% case
while reloading; the other two reported the test deadline. The run was stopped
after these failures and the keyboard owner rerun: 311 passed, five failed,
four interrupted, 62 skipped, 822 not run, 1,038.5 s, exit 130. Evidence: host
temporary artifact directory `orkestrator-test-run.bSlWGN`,
`review-fix-browser.log.gz`.

This owner was not rerun alone in this repair turn. These are outstanding
browser validation failures; the older isolated pass does not establish that
this observation is flaky. No MultiReviewFlow implementation, assertion,
timeout or skip changed.
