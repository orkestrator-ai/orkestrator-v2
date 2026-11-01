# Automatic paging does not reach the first row in time

- **ID:** 1602
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `native: history pages in without a click, opening with a page and paging near the top` (desktop Chromium)
- **File:** `e2e/TranscriptPaging.spec.ts:414`
- **Original command:** `mise run test:logged -- --name paging-final -- bunx playwright test --config e2e/playwright.config.ts TranscriptPaging.spec.ts -g "history pages in without a click|keeps changing past the revision budget|automatic opening page keeps following" --project=desktop-chromium --workers=1 --retries=1 --reporter=line`, on a host at load average 7 to 30 of 12 cores while seven agents ran elsewhere.
- **Workers:** one Playwright worker.
- **Failure:** usually `Reached stop 0.` was still absent when the 30 s poll at line 441 ended. Sometimes the opening request at line 427 ran twice (`before-200` retried after a poll superseded the first page).
- **Reruns:** with the held-history reconcile change, `--repeat-each=5` passed 2 of 5 (two failures at line 441, one at line 427). With that change reverted the test failed at line 441 and passed on retry, and it also failed at line 441 in a two-worker run.
- **Evidence:** `orkestrator-test-run.3G9cHy/paging-final.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent, and present without the change that observed it. Load and page supersession are hypotheses; no root cause was established. No assertion, timeout or skip changed.

## Agent mail review validation — 2026-11-01

The exact broad browser rerun used five workers and later hit the logged
runner's 1800-second deadline (last printed case 1122/1166; final counts
unavailable). Its two failures in `TranscriptPaging.spec.ts:22` were a
byte-bounded prepend index remaining 1 instead of increasing and a same-minute
page leaving scrollTop 0 instead of over 500.

The complete unchanged mobile owner was then rerun with one worker:
`mise run test:logged -- --name repair-paging-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --project mobile-chromium --workers=1 --output output/agent-testing/mail-review-owners/paging`.
Those two cases passed, but the file remained non-green: 18 passed, one
failed, 232.1 s. The automatic-history case at line 414 expected one opening
request and observed zero at line 441 by the 30-second deadline. No paging
implementation, assertion, timeout or skip changed. This is not a complete
passing isolated owner.

Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.LaDtCt/browser.log.gz`
and `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.90xq9n/repair-paging-browser-owner.log.gz`.
