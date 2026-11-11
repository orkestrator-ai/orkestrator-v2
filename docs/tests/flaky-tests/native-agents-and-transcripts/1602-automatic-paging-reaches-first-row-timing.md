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


## Workflow vocabulary review — 2026-11-04

- **Reviewed head:** `f735aabd0b4cbd3b3c38da602c3aa8b79b8357d0`.
- **Original command:** `ORKESTRATOR_E2E_PORT=55208 mise run test:logged -- --name review-browser-isolated-port -- mise run test:browser`.
- **Worker configuration and result:** nine component Playwright workers; 1,274 passed, 122 skipped and four failed in 24.4 minutes. The public-site stage did not run because the component stage failed.
- **Failure evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.fFxacM/review-browser-isolated-port.log.gz` and the validation summary `output/agent-testing/review-validation-f735aabd0.md`.
- **Failure:** mobile `native: history pages in without a click, opening with a page and paging near the top` (`e2e/TranscriptPaging.spec.ts:414`, assertion at `:441`) timed out after 30 seconds: expected one, received zero.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=54831 mise run test:logged -- --name review-paging-diagnostic -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --project mobile-chromium --workers=1 --output output/playwright/review-paging-diagnostic` passed. Passing counts and duration were not retained by the logged wrapper.
- **Assessment:** unchanged isolated passes confirm intermittent recurrence. The cause of this run is unconfirmed; no implementation, assertion, timeout or skip changed in these owners. The original aggregate remains failed.

## Transcript restoration repair — 2026-11-06

The two-owner browser command in case [0483](0483-transcript-paging-prepend-index-timing.md#transcript-restoration-repair--2026-11-06)
repeated the desktop failure at line 441: `Reached stop 0.` remained absent
until the 30 s poll expired (37 passed, three failed, two skipped, 80.8 s).
Evidence is in `orkestrator-test-run.7sBWhR/repair-transcript-browser.log.gz`
under the host temporary directory.

The complete unchanged paging owner passed both viewport projects with one
worker, exit 0, in 210.1 s:
`ORKESTRATOR_E2E_PORT=14861 mise run test:logged -- --name repair-paging-alone -- bunx playwright test --config e2e/playwright.config.ts --output output/playwright/repair-paging-alone e2e/TranscriptPaging.spec.ts --workers=1`.
No assertion, timeout, skip or automatic-paging implementation changed.

The subsequent exact combined rerun after the follow-driver fix passed 39,
failed the mobile automatic-paging case and skipped two in 75.4 s. The
unchanged paging owner had already passed alone; no automatic-paging
implementation or assertion was changed. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.IBipuK/repair-transcript-browser.log.gz`.
The combined run remains non-green and is reported as such.


## Native chat review repair validation — 2026-11-09

- **Observing branch base:** `448e9fffb992c3b6306aa6562c88e23c59fb74d8`; repair commits `4817327b8` and `852481f2f`.
- **Aggregate command:** `mise run test:logged -- --name browser -- mise run test:browser`, nine component-browser workers alongside focused browser checks. Mobile automatic paging reached its 30-second deadline with `Reached stop 0.` absent (expected one, received zero). The component run had 1,585 passes, 152 skips and three failures across 1,740 cases in 1,574.2 seconds; the public-site stage did not run.
- **First complete owner:** `ORKESTRATOR_E2E_PORT=1467 mise run test:logged -- --name paging-settled-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=1 --output output/playwright/paging-settled-owner` had 38 passes, one skip and this one mobile failure in 253.6 seconds. This was not a passing isolated owner.
- **Unchanged mobile owner:** `ORKESTRATOR_E2E_PORT=1467 mise run test:logged -- --name paging-current-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --project mobile-chromium --workers=1 --output output/playwright/paging-current-owner` then passed all 20 mobile cases, exit 0, in 126.6 seconds. No source, assertion, timeout or skip changed between these two owner runs.
- **Evidence:** aggregate `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.53aGI2/browser.log.gz`; first owner `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.cwpMcM/paging-settled-owner.log.gz`. Passing raw output was deleted by the logged runner.
- **Recurrence check:** `mise run flaky:recurrence -- 1602 --base 448e9fffb992c3b6306aa6562c88e23c59fb74d8` reported the case open.
- **Assessment:** confirmed intermittent recurrence; the cause of automatic paging stopping in these runs remains unconfirmed. The separate same-minute test now waits for its opening animations before measuring paging; its pixel bounds remain unchanged. The new coarse-pointer geometry check and both short-viewport paging cases passed in the failing owner too.

The subsequent exact `mise run test:logged -- --name browser -- mise run test:browser`
rerun passed every applicable paging case in both viewport projects, including
automatic paging. It remained red only on the unrelated cases 1249 and 1310
(1,586 passed, 152 skipped, two failed in 1,281.6 seconds). Evidence:
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.fSAO2z/browser.log.gz`.
The final invisible hit-area adjustment was separately verified by the unchanged
40px size and geometry assertions plus the new previous-content non-overlap
assertion (`touch-hit-area-final`, exit 0, 11.0 seconds).

## Action-search review repair — 2026-11-10

Preparation for the coordinator action-search branch (`action-search-modal-1162dc5c0a2a-r1`, base `53340356c`, validated at `300105a39`) ran `mise run test:logged -- --name browser -- mise run test:browser`: 5 failed, 5 flaky, 152 skipped, 1656 passed. The branch changes only the coordinator Actions panel, which renders for coordinator tabs; neither spec opens one. Evidence: `validation-11.stdout.txt` under `.orkestrator/review-artifacts/review-validation-985e2298-c3a5-42bd-bd66-83c90557e178/`. The mobile-chromium case failed its paging assertion.

The complete unchanged ToolGroupFold and TranscriptPaging owners then passed together with one worker (exit 0, 296.8 s):

```sh
mise run test:logged -- --name browser-owners -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts e2e/TranscriptPaging.spec.ts --workers=1
```

The cause remains unconfirmed. Status stays open. No assertion, timeout or skip changed.

## Recurrence 2026-11-11 (WebKit-scroll review)

Branch `webkit-scroll-fix-d230c4f38350-r1`, base
`498b68766f5c9f357a3a86782406d1e9e0977559`. The branch changes the shared
`useVirtuosoScrollState` hook, but only for callers that pass `visible` or
`viewKey` (the build pipeline transcript); the paging fixture passes neither,
so its activation path is unchanged.

- A browser suite run on a host at load average about 40, with two other
  worktrees' suites running, hit the 30-minute group deadline at 1199 of
  1850 tests. Among its 17 failures, mostly `page.reload`/`page.goto`
  timeouts, this case failed on mobile.
- The ten failing owners rerun together (`bunx playwright test --config e2e/playwright.config.ts <ten specs>`,
  default workers, same load) failed this case on both viewports:
  `expect(received).toBe(expected)`, expected 1, received 0, after the 30 s
  poll for `Reached stop 0.` (282 passed, 27 failed, mostly reload timeouts).
- The next complete `mise run test:browser` on the same tree (load about 31
  to 35) started this case on both viewports and did not fail it; its only
  failure was flake 1310.
- `mise run flaky:recurrence -- 1602 --base 498b68766f5c9f357a3a86782406d1e9e0977559 --registry-ref origin/main` reported `open`.

The cause remains unconfirmed. Status stays open. No assertion, timeout or skip changed.

Review round 2, same day and base, after commit `7fac685f4` changed the
hook's `viewKey` comparison (again only for callers that pass `viewKey`):

- `ORKESTRATOR_E2E_PORT=1497 mise run test:logged -- --name browser-rerun -- mise run test:browser`,
  at host load average about 30, was stopped by the 30-minute group deadline
  at 1849 of 1852 tests with three failures. On desktop this case exceeded
  the test timeout while tearing down its context.
- The complete owner alone (`bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --retries=0`)
  failed this case on both viewports (expected 1, received 0, then the test
  timeout); 37 passed.
- The case alone (`e2e/TranscriptPaging.spec.ts:450`) then passed, once with
  the hook restored to the validated commit `7b45fc7a0` (27.1 s) and once at
  `7fac685f4` (28.5 s), so the failure does not depend on that commit.
- `mise run flaky:recurrence -- 1602 --base 498b68766f5c9f357a3a86782406d1e9e0977559` reported `open`.

- A later complete `ORKESTRATOR_E2E_PORT=1498 mise run test:logged -- --name browser-rerun-3 -- mise run test:browser`
  at `3430c8d13` (load about 11 to 21) failed only this case, on mobile:
  1699 passed, 1 failed, 152 skipped (1284.6 s). The complete owner then
  passed alone (`--name paging-owner-final`, exit 0, 53.4 s).

Status stays open. No assertion, timeout or skip changed.

## Renderer error ring review — 2026-11-11

Branch `renderer-error-ring-e3a48fce2746-r1` (to-dos 6300 and 6301), base
`498b68766`; `mise run flaky:recurrence -- 1602 --base 498b68766` reported `open`.
The owning spec and its implementation are unchanged on the branch.

Review preparation's `mise run test:browser` (nine workers, 1690 passed, 152
skipped, two failed in 28.8 m) failed the mobile case at
`e2e/TranscriptPaging.spec.ts:477`: the opening request count stayed 0 after the
30 s poll, on the first attempt and the retry. Port 1422 was held by another
checkout's fixture server during the address stage. The complete unchanged owner,
with `DataSavingGateway`, then passed this case on both viewports with one worker
on port 14722:

```sh
NODE_ENV= ORKESTRATOR_E2E_PORT=14722 mise run test:logged -- --name browser-flake-owners -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts --workers=1 e2e/TranscriptPaging.spec.ts e2e/DataSavingGateway.spec.ts
```

That run (40 passed, one skipped, one failed in 6.3 m) failed only the mobile
byte-bounded prepend case recorded in 0483. Status stays open. No assertion,
timeout or skip changed.
