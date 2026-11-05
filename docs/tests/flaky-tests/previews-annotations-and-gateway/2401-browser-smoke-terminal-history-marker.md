# Browser smoke terminal history omits the completion marker

- **ID:** 2401
- **Status:** resolved
- **Date observed:** 2026-11-01
- **Test:** `real browser gateway exercises an authoritative local environment`
- **File:** `e2e/agent-testing/browser-gateway.spec.ts:634`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=cleanup-review-fixes NODE_ENV=test mise run test:logged -- --name cleanup-browser-smoke -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts --grep 'real browser gateway exercises an authoritative local environment' --workers=1`
- **Failure:** one failed, zero passed in 7.1 s, one worker. The terminal snapshot poll passed, but `historyPage?.rows.some((row) => row.text.includes("background-done"))` returned false instead of true. Logged evidence: `/tmp/orkestrator-test-run.4300O7/cleanup-browser-smoke.log.gz`.
- **Isolated rerun:** the exact command above, unchanged spec and same disposable profile: one passed, zero failed in 7.4 s (runner exit 0). This was already a single-case owner run; no aggregate siblings were involved.

## Current assessment

The snapshot contained the completion marker before the immediately following history-page assertion failed. This suggests a timing or page-boundary difference between snapshot output and paged history; the cause is unconfirmed. The cleanup dialog changes do not change either terminal read path. Preserve the assertion and investigate those read paths if this recurs.

## Recurrence: remote settings review, 2026-11-02

Against worktree `move-settings-bar-fb696c341b9a-r1` (base `d1270132c`),
profile `fix-remote-settings`, Chromium, one worker:

- Original combined command: `ORKESTRATOR_AGENT_TEST_PROFILE=fix-remote-settings ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name settings-browser-paths -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts container-settings.spec.ts --grep 'host picker creates|container settings show|real browser gateway exercises'`. Four settings cases passed; the smoke failed on a blank initial page after 30 s (55.6 s total). That page-load cause was not established.
- Owning-case command: `ORKESTRATOR_AGENT_TEST_PROFILE=fix-remote-settings ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name gateway-smoke-alone -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts --grep 'real browser gateway exercises'`. Failed at line 624 with the same history marker assertion (`Expected: true`, `Received: false`), one failed, zero passed, 6.3 s. Evidence: `/tmp/orkestrator-test-run.aAA858/gateway-smoke-alone.log.gz`.
- Exact unchanged owning-case rerun passed, one passed, zero failed, 4.2 s.
- No terminal read or assertion was changed. Snapshot/history timing remains an unconfirmed hypothesis.
- Exact combined-command rerun passed all five cases in 27.7 s, including desktop/narrow gateway settings and desktop/narrow container settings.

## Recurrence: subork review fixes, 2026-11-04

Worktree `subork-agent-command-19d44fc3d0c3-r1`, isolated profile
`agent-subork-review-fixes`, one Chromium worker. The unchanged owning case
failed at line 624 twice: the snapshot poll saw `background-done`, but the
following history page did not. Runs took 8.2 s and 9.0 s, each 0 passed / 1
failed. This recurrence was unresolved during the subork review; neither terminal
read path was changed by those repairs. The upstream root cause and spec fix
are recorded below.

Command: `ORKESTRATOR_AGENT_TEST_PROFILE=agent-subork-review-fixes ORKESTRATOR_AGENT_TEST_RUN_ID=subork-review-fixes-smoke mise run test:logged -- --name repair-browser-smoke -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --grep 'real browser gateway exercises an authoritative local environment' --workers=1`.

Evidence: `/tmp/orkestrator-test-run.70AlOh/repair-browser-smoke.log.gz` and
`/tmp/orkestrator-test-run.bbtANS/repair-browser-smoke.log.gz`. The spec, assertion
and terminal implementation were left unchanged. This is an observation of the
existing case, not a claim that an isolated rerun passed this time.

## Root cause and fix, 2026-11-04

Not a read-path difference: the archive dropped the line. The spec prints 1,100 lines, and `enqueueHistoryRecord` admits 256 queued records per session (`TERMINAL_HISTORY_PENDING_RECORDS`), draining on a 250 ms timer. When the burst outruns that, the later lines are dropped and the session reports `historyGap`. The state snapshot is unaffected, which is why it held the marker. So the case passed only when the burst happened to be slow enough.

- **Evidence:** `output/agent-testing/qa-browser-08cf3c58-15c/browser/artifacts/browser-gateway-real-brows-5ed26-oritative-local-environment/trace.zip`, from `mise run test:agent:browser:isolated` at `0f586e738`. The snapshot at 23:51:00.996 held the marker; the page 17 ms later had 258 rows, `historyGap: true` and no marker.
- **Fix:** the spec keeps the strict check when the page reports no gap. It then prints a second line after that read, which drained the queue, and requires that line in the history whether or not the burst overflowed. The marker is printed with `printf 'background-%s\n' done`, so the echoed command can no longer satisfy the snapshot poll.
- **Verification:** `real browser gateway exercises…` passed 3 of 3 with `--repeat-each=3 --workers=1`, alongside the other two cases in [0901](../web-ui/0901-cli-ui-fixture-project-hydration.md). Those runs do not show which branch of the check each one took.
- **Follow-up:** the bound itself was to-do 4223, closed below. The blank page in the 2026-11-02 recurrence above was not checked against 0901's cause.

## Archive fix, 2026-11-05

To-do 4223 changed the archive itself. A flush writes its records in one `appendFile` per segment and starts at 256 queued records or 256 KiB rather than waiting for the timer, and the queue holds 12,288 records per session and 196,608 overall. Each record now counts 80 bytes against the unchanged byte bounds of 1 MiB per session and 16 MiB overall. This burst queues about 600 KiB, so it fits whatever the timing, and the spec again requires the marker with no gap.

- **Verification:** `real browser gateway exercises…` passed 3 of 3 with `--repeat-each=3 --workers=1` on a credential-free isolated profile. That profile's Claude login dialog blocks the page, so for those runs only, the case's two fixture-name visibility checks were removed and a handler for the dialog added. The checks on the terminal, the history and the diff ran unchanged. The unmodified spec on a credentialed profile was not run here.
- **Remaining limit:** floods of very short lines could still overflow; closed below.

## Raw output queue, 2026-11-05

To-do 5660 changed the queue again. It now holds raw output, charged by its bytes plus 80 per chunk, and splits it into rows when writing. The byte bounds are unchanged, and the record bounds became 12,288 chunks per session and 196,608 overall. This burst still fits whatever the timing, because it queues about 530 KiB.

- **Verification:** `real browser gateway exercises…` passed 3 of 3 with `--repeat-each=3 --workers=1` on a credential-free isolated profile. On that profile a startup dialog covers the page and the unmodified case fails at its first fixture-name visibility check (line 574), before the terminal step. So, for those runs only, the case's two fixture-name visibility checks before the history checks were removed. The checks on the terminal, the history and the diff ran unchanged. The unmodified spec on a credentialed profile was not run here. Separately, the same burst command in a real terminal on that profile kept all 1,100 rows and its marker with no gap, and `keeps every line of a burst over 256 lines delivered as one chunk` in `terminal-history.test.ts` covers the shape.
- **Remaining limit:** a flood past the bound still reports `historyGap`. `seq 1 1000000` in a real terminal kept 958,924 rows; `seq 1 20000` and `seq 1 100000` kept every line.
