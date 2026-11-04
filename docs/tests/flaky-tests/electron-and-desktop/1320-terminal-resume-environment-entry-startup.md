# Terminal resume environment entry misses its startup deadline

- **ID:** 1320
- **Status:** open
- **Date observed:** 2026-10-30
- **Test:** `Electron keeps a lost terminal write fenced until Resume, without restarting the PTY`
- **File:** `e2e/agent-testing/terminal-input-resume-electron.spec.ts:100`
- **Original command:** `mise run test:logged -- --name agent-electron -- mise run test:agent:electron`
- **Failure:** preparation reported 43 passed, two skipped and one failed (730.1 s logged). `openEnvironment` timed out at `entry.click()` after 20 seconds. The locator log shows the startup handler dismissing `Continue Without GitHub CLI` before waiting for the environment entry again. This differs from the startup-title symptom in case 0470.
- **Owning file rerun:** `mise run test:logged -- --name terminal-resume-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/terminal-input-resume-electron.spec.ts --workers=1` passed unchanged (one test, 14.6 s logged).
- **Full rerun:** the exact original command passed (45 passed, two skipped, 398.0 s logged), including terminal resume and every annotation scenario.
- **Cause:** unconfirmed; the startup dialog coincided with the failed navigation. No assertion, timeout, skip, or terminal behavior changed.
- **Evidence:** preparation's `.orkestrator/review-artifacts/review-validation-a8c0e711-25a8-4c84-a30d-03f93a79008b/validation-06.stderr.txt` and bounded failure log `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.hnDoI9/`.

## 2026-11-04 qualification follow-up

Review preparation at `3e14a9bab` reported a different failure in the same test:
`Terminal input failed` never appeared, with the reachability dialog handler
running during the toast assertion. The round's exact Electron command rerun
finished with 29 passed, 11 failed, one skipped and 19 not run (636.3 s), and
this case failed earlier on the initial editor-text assertion. Evidence:
`/tmp/orkestrator-test-run.zRQGtm/agent-electron.log.gz`.

The owning file reproduced the editor-text failure alone. Qualification repairs
restore focus before raw input, wait for the empty editor's ruler rather than
the echoed shell command, and insert the initial text in one chunk so nvim's
per-keystroke redraws do not split it. Refocusing uses a trial click away from
the persistent toast followed by xterm textarea focus: a real click changes
vim's cursor. The exact saved-file and shell-PID assertions remain unchanged.

`mise run test:logged -- --name terminal-electron-owner -- bunx playwright test
--config e2e/agent-testing/playwright.electron.config.ts
e2e/agent-testing/terminal-input-resume-electron.spec.ts --workers=1` passed
(one test, 13.9 s) after these repairs. Earlier isolated failures are retained at
`/tmp/orkestrator-test-run.ey52za`, `/tmp/orkestrator-test-run.fbfqeI`,
`/tmp/orkestrator-test-run.SUsZf8` and `/tmp/orkestrator-test-run.bDd0iF`.
This does not establish the cause of the original environment-entry timeout;
case 1320 remains open for that distinct symptom.
